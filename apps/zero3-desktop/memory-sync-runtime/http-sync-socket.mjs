// HTTP replay fallback for hosts that cannot pass Authorization on WebSocket
// handshakes. Uses the same ordered events/ACK protocol and durable client port.
export function createHttpSyncSocket({ baseUrl, token, fetchImpl = fetch, pollMs = 1000 }) {
  let onOpen, onMessage, onError
  let timer, stopped = false, cursor = 0, projectId, ready = false, awaiting = null
  const controller = new AbortController()
  const emit = value => onMessage?.(JSON.stringify(value))
  async function poll() {
    if (stopped) return
    try {
      const url = new URL('/v1/memory/events', baseUrl)
      url.searchParams.set('project_id', projectId)
      url.searchParams.set('after', String(cursor))
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), redirect: 'error' })
      if (!response.ok) throw new Error(`memory replay returned HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body.events)) throw new Error('invalid memory replay response')
      if (stopped) return
      if (body.events.length) {
        awaiting = body.events.at(-1)?.sequence
        if (!Number.isSafeInteger(awaiting) || awaiting <= cursor) throw new Error('invalid memory replay sequence')
        emit({ type: 'events', events: body.events })
        // Continue replay only after the durable store ACKs the entire page.
        return
      }
      if (!ready) { ready = true; emit({ type: 'ready', latest_sequence: cursor }) }
      timer = setTimeout(poll, pollMs)
      timer.unref?.()
    } catch (error) { if (!stopped) onError?.(error) }
  }
  return {
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'hello') {
        if (message.projects.length !== 1) throw new Error('HTTP sync requires one project per subscription')
        projectId = message.projects[0]; cursor = message.last_sequence
        void poll()
      } else if (message.type === 'ack') {
        if (!Number.isSafeInteger(message.sequence) || message.sequence > awaiting) throw new Error('invalid replay ACK')
        cursor = Math.max(cursor, message.sequence)
        if (cursor === awaiting) {
          awaiting = null
          timer = setTimeout(poll, 0)
          timer.unref?.()
        }
      }
    },
    close() { stopped = true; clearTimeout(timer); controller.abort() },
    onOpen(handler) { onOpen = handler; timer = setTimeout(() => { if (!stopped) onOpen() }, 0); timer.unref?.() },
    onMessage(handler) { onMessage = handler },
    onError(handler) { onError = handler },
    onClose() {}
  }
}
