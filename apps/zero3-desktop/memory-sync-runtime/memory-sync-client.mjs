const MAX_BATCH = 100
const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000, 30000]

export class MemorySyncError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MemorySyncError'
    this.code = code
    this.details = details
  }
}

function nonEmpty(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new MemorySyncError('invalid_config', `${label} is required`)
  return text
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) throw new MemorySyncError('invalid_config', 'at least one project is required')
  return [...new Set(projects.map((item, index) => nonEmpty(item, `projects[${index}]`)))]
}

function endpointUrl(baseUrl, relativePath) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  url.pathname = `${basePath}${String(relativePath).replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
  url.search = ''
  url.hash = ''
  return url
}
function websocketUrl(baseUrl) {
  const url = endpointUrl(baseUrl, 'v1/sync')
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new MemorySyncError('invalid_config', 'memory base URL must be http or https')
  return url.toString()
}
function httpUrl(baseUrl, relativePath) { return endpointUrl(baseUrl, relativePath).toString() }

export class MemorySyncClient {
  #config
  #socket = null
  #stopped = true
  #connecting = false
  #reconnectIndex = 0
  #reconnectTimer = null
  #flushing = false
  #ready = false

  constructor(config) {
    const store = config?.store
    for (const method of ['getCursor', 'setCursor', 'cacheServerEvent', 'nextBatch', 'markSending', 'markAcked', 'markConflict', 'markRejected', 'resetInflight']) {
      if (typeof store?.[method] !== 'function') throw new MemorySyncError('invalid_config', `store.${method} is required`)
    }
    if (typeof config?.socketFactory !== 'function') throw new MemorySyncError('invalid_config', 'socketFactory is required')
    if (typeof config?.fetchImpl !== 'function') throw new MemorySyncError('invalid_config', 'fetchImpl is required')
    this.#config = {
      baseUrl: nonEmpty(config.baseUrl, 'baseUrl'),
      token: nonEmpty(config.token, 'token'),
      clientId: nonEmpty(config.clientId, 'clientId'),
      deviceId: nonEmpty(config.deviceId, 'deviceId'),
      projects: normalizeProjects(config.projects),
      store,
      socketFactory: config.socketFactory,
      fetchImpl: config.fetchImpl,
      setTimeoutImpl: config.setTimeoutImpl ?? setTimeout,
      clearTimeoutImpl: config.clearTimeoutImpl ?? clearTimeout,
      backoff: Array.isArray(config.backoff) && config.backoff.length ? [...config.backoff] : DEFAULT_BACKOFF,
      onState: typeof config.onState === 'function' ? config.onState : () => {},
      onError: typeof config.onError === 'function' ? config.onError : () => {}
    }
  }

  get ready() { return this.#ready }

  async start() {
    if (!this.#stopped) return
    this.#stopped = false
    await this.#config.store.resetInflight()
    await this.#connect()
  }

  async stop() {
    this.#stopped = true
    this.#ready = false
    if (this.#reconnectTimer) {
      this.#config.clearTimeoutImpl(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    const socket = this.#socket
    this.#socket = null
    socket?.close?.()
    this.#emitState('stopped')
  }

  async flushPending() {
    if (this.#flushing || this.#stopped) return
    this.#flushing = true
    try {
      while (!this.#stopped) {
        const pending = await this.#config.store.nextBatch(MAX_BATCH)
        if (!pending.length) break
        const ids = pending.map(item => item.event_id)
        await this.#config.store.markSending(ids)
        let response
        try {
          response = await this.#config.fetchImpl(httpUrl(this.#config.baseUrl, '/v1/memory/events:batch'), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.#config.token}`,
              'content-type': 'application/json',
              accept: 'application/json'
            },
            body: JSON.stringify({ events: pending.map(item => item.payload) })
          })
        } catch (error) {
          await this.#config.store.resetInflight()
          throw new MemorySyncError('batch_network_error', error instanceof Error ? error.message : String(error))
        }
        if (!response?.ok) {
          await this.#config.store.resetInflight()
          throw new MemorySyncError('batch_http_error', `memory batch returned HTTP ${response?.status ?? 'unknown'}`)
        }
        const body = await response.json()
        if (!Array.isArray(body?.results)) {
          await this.#config.store.resetInflight()
          throw new MemorySyncError('invalid_batch_response', 'memory batch response is missing results')
        }
        const byId = new Map(body.results.map(item => [item.event_id, item]))
        for (const id of ids) {
          const result = byId.get(id)
          if (!result) {
            await this.#config.store.markRejected(id, 'missing_batch_result')
            continue
          }
          if ((result.status === 'accepted' || result.status === 'duplicate') && Number.isSafeInteger(result.sequence) && result.sequence > 0) {
            await this.#config.store.markAcked(id, result.sequence)
          } else if (result.status === 'conflict') {
            await this.#config.store.markConflict(id, result.error ?? 'memory_conflict')
          } else {
            await this.#config.store.markRejected(id, result.error ?? 'memory_event_rejected')
          }
        }
        if (pending.length < MAX_BATCH) break
      }
    } finally {
      this.#flushing = false
    }
  }

  async #connect() {
    if (this.#stopped || this.#connecting || this.#socket) return
    this.#connecting = true
    this.#emitState('connecting')
    try {
      const socket = await this.#config.socketFactory(websocketUrl(this.#config.baseUrl), {
        headers: { authorization: `Bearer ${this.#config.token}` },
        protocol: 'zero3.memory.sync.v1'
      })
      if (this.#stopped) {
        socket.close?.()
        return
      }
      this.#socket = socket
      socket.onOpen(() => { void this.#onOpen(socket) })
      socket.onMessage(message => { void this.#onMessage(socket, message) })
      socket.onClose(() => { this.#onDisconnect(socket, null) })
      socket.onError(error => { this.#onDisconnect(socket, error) })
    } catch (error) {
      this.#scheduleReconnect(error)
    } finally {
      this.#connecting = false
    }
  }

  async #onOpen(socket) {
    if (socket !== this.#socket || this.#stopped) return
    const cursor = await this.#config.store.getCursor(this.#config.clientId)
    socket.send(JSON.stringify({
      type: 'hello',
      protocol: 'zero3.memory.sync.v1',
      client_id: this.#config.clientId,
      device_id: this.#config.deviceId,
      last_sequence: cursor?.last_sequence ?? 0,
      projects: this.#config.projects
    }))
  }

  async #onMessage(socket, raw) {
    if (socket !== this.#socket || this.#stopped) return
    let message
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
    } catch {
      this.#config.onError(new MemorySyncError('invalid_sync_frame', 'memory sync frame is not valid JSON'))
      return
    }
    switch (message?.type) {
      case 'ready':
        this.#ready = true
        this.#reconnectIndex = 0
        this.#emitState('ready', { latest_sequence: message.latest_sequence })
        void this.flushPending().catch(error => this.#config.onError(error))
        break
      case 'events':
        if (!Array.isArray(message.events)) throw new MemorySyncError('invalid_sync_frame', 'events frame must contain events')
        for (const committed of message.events) await this.#applyCommitted(socket, committed)
        break
      case 'memory.changed':
        await this.#applyCommitted(socket, { sequence: message.sequence, event: message.event })
        break
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong', at: message.at ?? new Date().toISOString() }))
        break
      case 'error': {
        const retryable = Boolean(message.retryable)
        const error = new MemorySyncError(message.code ?? 'server_sync_error', message.message ?? 'memory sync server error', { retryable })
        this.#config.onError(error)
        if (retryable) {
          this.#onDisconnect(socket, error)
        } else {
          this.#stopped = true
          this.#ready = false
          this.#socket = null
          try { socket.close?.() } catch {}
          this.#emitState('blocked', { code: error.code })
        }
        break
      }
      default:
        this.#config.onError(new MemorySyncError('unknown_sync_frame', `unknown memory sync frame ${String(message?.type)}`))
    }
  }

  async #applyCommitted(socket, committed) {
    const sequence = committed?.sequence
    const event = committed?.event
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !event || typeof event !== 'object') {
      throw new MemorySyncError('invalid_committed_event', 'committed memory event is malformed')
    }
    await this.#config.store.cacheServerEvent(sequence, event.event_id, event)
    await this.#config.store.setCursor(this.#config.clientId, this.#config.deviceId, sequence)
    socket.send(JSON.stringify({ type: 'ack', sequence }))
  }

  #onDisconnect(socket, error) {
    if (socket !== this.#socket) return
    this.#socket = null
    this.#ready = false
    try { socket.close?.() } catch {}
    this.#scheduleReconnect(error)
  }

  #scheduleReconnect(error) {
    if (this.#stopped) return
    const status = Number(error?.statusCode ?? error?.status ?? 0)
    if (status === 401 || status === 403) {
      this.#stopped = true
      this.#ready = false
      const blocked = error instanceof Error ? error : new MemorySyncError('socket_auth_error', String(error))
      this.#config.onError(blocked)
      this.#emitState('blocked', { status })
      return
    }
    if (error) this.#config.onError(error instanceof Error ? error : new MemorySyncError('socket_error', String(error)))
    if (this.#reconnectTimer) return
    const delay = this.#config.backoff[Math.min(this.#reconnectIndex, this.#config.backoff.length - 1)]
    this.#reconnectIndex += 1
    this.#emitState('reconnecting', { delay })
    this.#reconnectTimer = this.#config.setTimeoutImpl(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delay)
  }

  #emitState(state, details = {}) {
    this.#config.onState({ state, ...details })
  }
}

export function memorySocketPort(socket) {
  if (!socket || typeof socket.send !== 'function') throw new MemorySyncError('invalid_socket', 'socket is required')
  return {
    send: value => socket.send(value),
    close: () => socket.close(),
    onOpen: handler => socket.addEventListener('open', handler, { once: true }),
    onMessage: handler => socket.addEventListener('message', event => handler(event.data)),
    onClose: handler => socket.addEventListener('close', handler, { once: true }),
    onError: handler => socket.addEventListener('error', handler, { once: true })
  }
}
