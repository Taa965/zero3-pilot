import type { LocalSessionMessage, LocalSessionRecord, LocalSessionThinkingEffort } from '../conversations/session-types'

const STORAGE_KEY = 'zero3.native-session-events.v1'
const CHANGE_EVENT = 'zero3-native-session-events-changed'
const MAX_SESSIONS = 300
const MAX_EVENTS = 600
const MAX_TEXT = 32_000

export type Zero3SessionEventType =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'approval'
  | 'artifact'
  | 'providerSwitch'
  | 'turnState'
  | 'runtime'

export type Zero3SessionEvent = {
  eventId: string
  logicalSessionId: string
  sessionSeq: number
  type: Zero3SessionEventType
  createdAt: string
  turnId?: string
  itemId?: string
  runtimeThreadId?: string
  profileId?: string
  payload: Record<string, unknown>
}
export type Zero3SessionRuntimeBinding = {
  generation: number
  profileId: string | null
  model: string | null
  thinkingEffort: LocalSessionThinkingEffort | null
  runtimeThreadId: string | null
  projectId: string | null
  updatedAt: string
}

export type Zero3SessionCoverage = {
  coveredSessionSeq: number
  coveredRanges: Array<[number, number]>
}

export type Zero3ProviderSwitchPhase = 'ACTIVE' | 'HANDOFF_PENDING' | 'HANDOFF_VERIFYING' | 'SWITCHING' | 'FAILED'
export type Zero3ProviderSwitchState = {
  phase: Zero3ProviderSwitchPhase
  sourceGeneration: number
  targetGeneration: number | null
  token: string | null
  targetProfileId: string | null
  error: string | null
  updatedAt: string
}

export type Zero3SessionTransferBatch = {
  startSeq: number
  endSeq: number
  events: Array<Record<string, unknown>>
}

export type Zero3ProviderHandoff = {
  protocol: 'zero3.session-provider-handoff.v1'
  logical_session_id: string
  project_id: string | null
  from: Record<string, unknown>
  to: Record<string, unknown>
  shared_memory: Record<string, unknown>
  coverage: { covered_session_seq: number; covered_ranges: Array<[number, number]> }
  uncovered_session_delta: { start_seq: number | null; end_seq: number | null; events: Array<Record<string, unknown>> }
  runtime_state: Record<string, unknown>
  handoff: { generated_at: string; source_runtime_generation: number; target_runtime_generation: number }
}

type StoredSession = {
  version: 1
  nextSeq: number
  events: Zero3SessionEvent[]
  binding: Zero3SessionRuntimeBinding
  coverage: Zero3SessionCoverage
  switchState: Zero3ProviderSwitchState
  pendingHandoff: Zero3ProviderHandoff | null
}

type StoreRoot = { version: 1; sessions: Record<string, StoredSession> }
function now() { return new Date().toISOString() }
function uid(prefix: string) {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}-${id}`
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function boundedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value)
  if (json.length <= 96_000) return value
  return { truncated: true, preview: json.slice(0, 90_000) }
}
function emptyBinding(): Zero3SessionRuntimeBinding {
  return { generation: 1, profileId: null, model: null, thinkingEffort: null, runtimeThreadId: null, projectId: null, updatedAt: now() }
}
function emptySwitchState(generation = 1): Zero3ProviderSwitchState {
  return { phase: 'ACTIVE', sourceGeneration: generation, targetGeneration: null, token: null, targetProfileId: null, error: null, updatedAt: now() }
}
function emptySession(): StoredSession {
  return { version: 1, nextSeq: 1, events: [], binding: emptyBinding(), coverage: { coveredSessionSeq: 0, coveredRanges: [] }, switchState: emptySwitchState(), pendingHandoff: null }
}
function normalizeRanges(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => Array.isArray(item) && Number.isSafeInteger(item[0]) && Number.isSafeInteger(item[1]) && item[0] > 0 && item[1] >= item[0]
    ? [[item[0], item[1]] as [number, number]] : [])
}
function compactCoverage(value: Zero3SessionCoverage): Zero3SessionCoverage {
  let coveredSessionSeq = Math.max(0, value.coveredSessionSeq)
  const merged: Array<[number, number]> = []
  for (const [start, end] of normalizeRanges(value.coveredRanges).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (end <= coveredSessionSeq) continue
    const normalizedStart = Math.max(start, coveredSessionSeq + 1)
    const last = merged.at(-1)
    if (last && normalizedStart <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([normalizedStart, end])
  }
  while (merged[0] && merged[0][0] <= coveredSessionSeq + 1) {
    coveredSessionSeq = Math.max(coveredSessionSeq, merged.shift()![1])
  }
  return { coveredSessionSeq, coveredRanges: merged }
}
function addCoverageRange(value: Zero3SessionCoverage, start: number, end: number): Zero3SessionCoverage {
  return compactCoverage({ coveredSessionSeq: value.coveredSessionSeq, coveredRanges: [...value.coveredRanges, [start, end]] })
}
function normalizeEvent(value: unknown): Zero3SessionEvent | null {
  const raw = record(value)
  if (typeof raw.eventId !== 'string' || typeof raw.logicalSessionId !== 'string' || !Number.isSafeInteger(raw.sessionSeq) || typeof raw.type !== 'string') return null
  return { ...raw, payload: boundedPayload(record(raw.payload)) } as Zero3SessionEvent
}
function normalizeSession(value: unknown): StoredSession {
  const raw = record(value)
  const events = Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter((event): event is Zero3SessionEvent => Boolean(event)).slice(-MAX_EVENTS) : []
  const bindingRaw = record(raw.binding)
  const binding: Zero3SessionRuntimeBinding = {
    generation: Number.isSafeInteger(bindingRaw.generation) && Number(bindingRaw.generation) > 0 ? Number(bindingRaw.generation) : 1,
    profileId: typeof bindingRaw.profileId === 'string' ? bindingRaw.profileId : null,
    model: typeof bindingRaw.model === 'string' ? bindingRaw.model : null,
    thinkingEffort: ['low','medium','high','xhigh','max'].includes(String(bindingRaw.thinkingEffort)) ? bindingRaw.thinkingEffort as LocalSessionThinkingEffort : null,
    runtimeThreadId: typeof bindingRaw.runtimeThreadId === 'string' ? bindingRaw.runtimeThreadId : null,
    projectId: typeof bindingRaw.projectId === 'string' ? bindingRaw.projectId : null,
    updatedAt: typeof bindingRaw.updatedAt === 'string' ? bindingRaw.updatedAt : now()
  }
  const coverageRaw = record(raw.coverage)
  const switchRaw = record(raw.switchState)
  const switchPhase = ['ACTIVE','HANDOFF_PENDING','HANDOFF_VERIFYING','SWITCHING','FAILED'].includes(String(switchRaw.phase)) ? switchRaw.phase as Zero3ProviderSwitchPhase : 'ACTIVE'
  const maxSeq = events.reduce((max, event) => Math.max(max, event.sessionSeq), 0)
  return {
    version: 1,
    nextSeq: Number.isSafeInteger(raw.nextSeq) && Number(raw.nextSeq) > maxSeq ? Number(raw.nextSeq) : maxSeq + 1,
    events,
    binding,
    coverage: compactCoverage({
      coveredSessionSeq: Number.isSafeInteger(coverageRaw.coveredSessionSeq) && Number(coverageRaw.coveredSessionSeq) >= 0 ? Number(coverageRaw.coveredSessionSeq) : 0,
      coveredRanges: normalizeRanges(coverageRaw.coveredRanges)
    }),
    switchState: {
      phase: switchPhase,
      sourceGeneration: Number.isSafeInteger(switchRaw.sourceGeneration) && Number(switchRaw.sourceGeneration) > 0 ? Number(switchRaw.sourceGeneration) : binding.generation,
      targetGeneration: Number.isSafeInteger(switchRaw.targetGeneration) && Number(switchRaw.targetGeneration) > 0 ? Number(switchRaw.targetGeneration) : null,
      token: typeof switchRaw.token === 'string' ? switchRaw.token : null,
      targetProfileId: typeof switchRaw.targetProfileId === 'string' ? switchRaw.targetProfileId : null,
      error: typeof switchRaw.error === 'string' ? switchRaw.error : null,
      updatedAt: typeof switchRaw.updatedAt === 'string' ? switchRaw.updatedAt : now()
    },
    pendingHandoff: record(raw.pendingHandoff).protocol === 'zero3.session-provider-handoff.v1' ? raw.pendingHandoff as Zero3ProviderHandoff : null
  }
}

function readRoot(): StoreRoot {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    const root = record(parsed)
    const sessionsRaw = record(root.sessions)
    const sessions = Object.fromEntries(Object.entries(sessionsRaw).slice(-MAX_SESSIONS).map(([id, value]) => [id, normalizeSession(value)]))
    return { version: 1, sessions }
  } catch { return { version: 1, sessions: {} } }
}
function writeRoot(root: StoreRoot) {
  const ids = Object.keys(root.sessions)
  if (ids.length > MAX_SESSIONS) {
    ids.slice(0, ids.length - MAX_SESSIONS).forEach(id => { delete root.sessions[id] })
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}
function mutate(logicalSessionId: string, update: (session: StoredSession) => StoredSession): StoredSession {
  const root = readRoot()
  const next = update(root.sessions[logicalSessionId] ?? emptySession())
  root.sessions[logicalSessionId] = { ...next, events: next.events.slice(-MAX_EVENTS) }
  writeRoot(root)
  return root.sessions[logicalSessionId]
}
function append(logicalSessionId: string, type: Zero3SessionEventType, payload: Record<string, unknown>, meta: Partial<Zero3SessionEvent> = {}): Zero3SessionEvent {
  let appended!: Zero3SessionEvent
  mutate(logicalSessionId, session => {
    appended = {
      eventId: meta.eventId ?? uid('evt'), logicalSessionId, sessionSeq: session.nextSeq, type,
      createdAt: meta.createdAt ?? now(), payload: boundedPayload(payload),
      ...(meta.turnId ? { turnId: meta.turnId } : {}), ...(meta.itemId ? { itemId: meta.itemId } : {}),
      ...(meta.runtimeThreadId ? { runtimeThreadId: meta.runtimeThreadId } : {}), ...(meta.profileId ? { profileId: meta.profileId } : {})
    }
    return { ...session, nextSeq: session.nextSeq + 1, events: [...session.events, appended] }
  })
  return appended
}
function updateItem(logicalSessionId: string, itemId: string, type: Zero3SessionEventType, updater: (payload: Record<string, unknown>) => Record<string, unknown>, meta: Partial<Zero3SessionEvent> = {}) {
  let found = false
  mutate(logicalSessionId, session => ({ ...session, events: session.events.map(event => {
    if (event.itemId !== itemId || event.type !== type) return event
    found = true
    return { ...event, ...meta, payload: boundedPayload(updater(event.payload)) }
  }) }))
  if (!found) append(logicalSessionId, type, updater({}), { ...meta, itemId })
}
function itemEventType(itemType: unknown): Zero3SessionEventType | null {
  if (itemType === 'userMessage') return 'userMessage'
  if (itemType === 'agentMessage') return 'agentMessage'
  if (itemType === 'reasoning' || itemType === 'plan') return 'reasoning'
  if (itemType === 'commandExecution') return 'commandExecution'
  if (itemType === 'fileChange') return 'fileChange'
  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall' || itemType === 'webSearch') return 'mcpToolCall'
  return null
}
function threadIdFrom(params: Record<string, unknown>): string | undefined {
  return typeof params.threadId === 'string' ? params.threadId : undefined
}
function turnIdFrom(params: Record<string, unknown>): string | undefined {
  if (typeof params.turnId === 'string') return params.turnId
  const turn = record(params.turn)
  return typeof turn.id === 'string' ? turn.id : undefined
}
function appendDelta(current: unknown, delta: unknown, max = MAX_TEXT): string {
  return (text(current, max) + text(delta, max)).slice(-max)
}
function completedItemPayload(item: Record<string, unknown>) {
  return { ...item, phase: 'complete', status: typeof item.status === 'string' ? item.status : 'completed' }
}
function startedItemPayload(item: Record<string, unknown>) {
  return { ...item, phase: 'running', status: typeof item.status === 'string' ? item.status : 'inProgress' }
}

export type Zero3CodexEventEnvelope =
  | { kind: 'lifecycle'; state: string; detail?: string }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: number | string; method: string; params: unknown }

function safeEventForHandoff(event: Zero3SessionEvent): Record<string, unknown> {
  const payload = { ...event.payload }
  if (typeof payload.output === 'string') payload.output = payload.output.slice(-8_000)
  if (typeof payload.text === 'string') payload.text = payload.text.slice(-12_000)
  return { session_seq: event.sessionSeq, type: event.type, created_at: event.createdAt, item_id: event.itemId ?? null, turn_id: event.turnId ?? null, payload }
}
function covered(seq: number, coverage: Zero3SessionCoverage) {
  if (seq <= coverage.coveredSessionSeq) return true
  return coverage.coveredRanges.some(([start, end]) => seq >= start && seq <= end)
}
function transferBatches(events: Zero3SessionEvent[], maxEvents = 48, maxBytes = 420_000): Zero3SessionTransferBatch[] {
  const batches: Zero3SessionTransferBatch[] = []
  let current: Zero3SessionTransferBatch | null = null
  let currentBytes = 0
  for (const event of events) {
    const safe = safeEventForHandoff(event)
    const bytes = new TextEncoder().encode(JSON.stringify(safe)).byteLength
    const contiguous = current != null && event.sessionSeq === current.endSeq + 1
    if (!current || !contiguous || current.events.length >= maxEvents || currentBytes + bytes > maxBytes) {
      current = { startSeq: event.sessionSeq, endSeq: event.sessionSeq, events: [safe] }
      batches.push(current)
      currentBytes = bytes
    } else {
      current.endSeq = event.sessionSeq
      current.events.push(safe)
      currentBytes += bytes
    }
  }
  return batches
}
function switchError(message: string) { return new Error('Zero3 Provider Switch: ' + message) }
export const Zero3SessionEventStore = {
  snapshot(logicalSessionId: string): StoredSession {
    return readRoot().sessions[logicalSessionId] ?? emptySession()
  },

  events(logicalSessionId: string): Zero3SessionEvent[] {
    return this.snapshot(logicalSessionId).events
  },

  appendUser(logicalSessionId: string, content: string, meta: Partial<Zero3SessionEvent> = {}) {
    return append(logicalSessionId, 'userMessage', { text: content.slice(0, MAX_TEXT) }, meta)
  },

  appendAssistant(logicalSessionId: string, content: string, meta: Partial<Zero3SessionEvent> = {}) {
    const normalized = content.trim()
    const existing = this.events(logicalSessionId).findLast(event => event.type === 'agentMessage' && text(event.payload.text).trim() === normalized)
    return existing ?? append(logicalSessionId, 'agentMessage', { text: normalized, phase: 'complete', status: 'completed' }, meta)
  },

  ensureMigrated(session: LocalSessionRecord) {
    const current = this.snapshot(session.id)
    if (current.events.length) return current
    for (const message of session.messages) {
      const meta = { eventId: `legacy-${message.id}`, createdAt: message.createdAt }
      if (message.role === 'user') this.appendUser(session.id, message.content, meta)
      else this.appendAssistant(session.id, message.content, meta)
    }
    this.setBinding(session.id, {
      profileId: session.zero3ProfileId, model: session.model, thinkingEffort: session.thinkingEffort,
      runtimeThreadId: session.runtimeId, projectId: session.projectId
    })
    return this.snapshot(session.id)
  },

  setBinding(logicalSessionId: string, patch: Partial<Zero3SessionRuntimeBinding>) {
    return mutate(logicalSessionId, session => ({ ...session, binding: { ...session.binding, ...patch, updatedAt: now() } })).binding
  },

  setRuntimeThread(logicalSessionId: string, runtimeThreadId: string | null) {
    return this.setBinding(logicalSessionId, { runtimeThreadId })
  },

  pendingHandoff(logicalSessionId: string) { return this.snapshot(logicalSessionId).pendingHandoff },
  switchState(logicalSessionId: string) { return this.snapshot(logicalSessionId).switchState },
  beginProviderSwitch(logicalSessionId: string, input: { token: string; targetGeneration: number; targetProfileId: string }) {
    return mutate(logicalSessionId, session => {
      if (session.switchState.phase !== 'ACTIVE' && session.switchState.phase !== 'FAILED') throw switchError('another switch is already in progress')
      if (input.targetGeneration !== session.binding.generation + 1) throw switchError('target generation is stale')
      return { ...session, switchState: { phase: 'HANDOFF_PENDING', sourceGeneration: session.binding.generation, targetGeneration: input.targetGeneration, token: input.token, targetProfileId: input.targetProfileId, error: null, updatedAt: now() } }
    }).switchState
  },
  markProviderSwitchVerifying(logicalSessionId: string, token: string) {
    return mutate(logicalSessionId, session => {
      if (session.switchState.phase !== 'HANDOFF_PENDING' || session.switchState.token !== token) throw switchError('handoff verification is not pending')
      return { ...session, switchState: { ...session.switchState, phase: 'HANDOFF_VERIFYING', updatedAt: now() } }
    }).switchState
  },
  failProviderSwitch(logicalSessionId: string, token: string | null, error: string) {
    return mutate(logicalSessionId, session => {
      if (token && session.switchState.token && token !== session.switchState.token) return session
      return { ...session, switchState: { ...session.switchState, phase: 'FAILED', error: error.slice(0, 4000), updatedAt: now() } }
    }).switchState
  },
  completeProviderSwitch(logicalSessionId: string) {
    const before = this.snapshot(logicalSessionId)
    const result = mutate(logicalSessionId, session => ({ ...session, pendingHandoff: null, switchState: emptySwitchState(session.binding.generation) }))
    if (before.switchState.phase === 'SWITCHING') append(logicalSessionId, 'providerSwitch', { phase: 'complete', targetGeneration: result.binding.generation, profileId: result.binding.profileId }, { profileId: result.binding.profileId ?? undefined })
    return this.snapshot(logicalSessionId)
  },
  clearPendingHandoff(logicalSessionId: string) {
    mutate(logicalSessionId, session => ({ ...session, pendingHandoff: null }))
  },
  markCoveredThrough(logicalSessionId: string, sessionSeq: number) {
    if (!Number.isSafeInteger(sessionSeq) || sessionSeq < 0) throw new Error('session coverage sequence must be a non-negative integer')
    return mutate(logicalSessionId, session => ({ ...session, coverage: compactCoverage({ coveredSessionSeq: Math.max(session.coverage.coveredSessionSeq, sessionSeq), coveredRanges: session.coverage.coveredRanges }) })).coverage
  },

  markCoveredRange(logicalSessionId: string, start: number, end: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('invalid session coverage range')
    return mutate(logicalSessionId, session => ({ ...session, coverage: addCoverageRange(session.coverage, start, end) })).coverage
  },

  transferBatches(logicalSessionId: string, maxEvents = 48, maxBytes = 420_000) {
    const session = this.snapshot(logicalSessionId)
    return transferBatches(session.events.filter(event => !covered(event.sessionSeq, session.coverage)), maxEvents, maxBytes)
  },

  uncovered(logicalSessionId: string) {
    const session = this.snapshot(logicalSessionId)
    return session.events.filter(event => !covered(event.sessionSeq, session.coverage))
  },

  buildProviderHandoff(logicalSessionId: string, input: {
    projectId: string | null
    fromProfile: Record<string, unknown>
    toProfile: Record<string, unknown>
    sharedMemory: Record<string, unknown>
    includeCoveredEvents?: boolean
  }): Zero3ProviderHandoff {
    const session = this.snapshot(logicalSessionId)
    const uncoveredEvents = input.includeCoveredEvents ? session.events : session.events.filter(event => !covered(event.sessionSeq, session.coverage))
    const lastUser = [...session.events].reverse().find(event => event.type === 'userMessage')
    const lastAssistant = [...session.events].reverse().find(event => event.type === 'agentMessage')
    const targetGeneration = session.binding.generation + 1
    return {
      protocol: 'zero3.session-provider-handoff.v1', logical_session_id: logicalSessionId, project_id: input.projectId,
      from: input.fromProfile, to: input.toProfile, shared_memory: input.sharedMemory,
      coverage: { covered_session_seq: session.coverage.coveredSessionSeq, covered_ranges: session.coverage.coveredRanges },
      uncovered_session_delta: {
        start_seq: uncoveredEvents[0]?.sessionSeq ?? null, end_seq: uncoveredEvents.at(-1)?.sessionSeq ?? null,
        events: uncoveredEvents.map(safeEventForHandoff)
      },
      runtime_state: {
        current_goal: lastUser ? text(lastUser.payload.text, 12_000) : '',
        latest_result: lastAssistant ? text(lastAssistant.payload.text, 12_000) : '',
        runtime_thread_id: session.binding.runtimeThreadId
      },
      handoff: { generated_at: now(), source_runtime_generation: session.binding.generation, target_runtime_generation: targetGeneration }
    }
  },
  stageProviderSwitch(logicalSessionId: string, handoff: Zero3ProviderHandoff, binding: {
    profileId: string; model: string | null; thinkingEffort: LocalSessionThinkingEffort | null; projectId: string | null
  }) {
    const before = this.snapshot(logicalSessionId)
    if (before.switchState.phase !== 'HANDOFF_VERIFYING') throw switchError('handoff has not been verified')
    if (before.switchState.targetGeneration !== handoff.handoff.target_runtime_generation || before.switchState.sourceGeneration !== handoff.handoff.source_runtime_generation) throw switchError('handoff generation is stale')
    if (before.switchState.targetProfileId !== binding.profileId) throw switchError('handoff target profile changed during switch')
    mutate(logicalSessionId, session => ({
      ...session,
      binding: { ...session.binding, generation: handoff.handoff.target_runtime_generation, profileId: binding.profileId, model: binding.model, thinkingEffort: binding.thinkingEffort, projectId: binding.projectId, updatedAt: now() },
      switchState: { ...session.switchState, phase: 'SWITCHING', error: null, updatedAt: now() },
      pendingHandoff: handoff
    }))
    append(logicalSessionId, 'providerSwitch', { phase: 'switching', from: handoff.from, to: handoff.to, inheritedEventCount: handoff.uncovered_session_delta.events.length, sharedMemoryStatus: handoff.shared_memory.status ?? 'unknown' }, { profileId: binding.profileId })
    return this.snapshot(logicalSessionId)
  },

  ingestCodexEvent(logicalSessionId: string, envelope: Zero3CodexEventEnvelope) {
    if (envelope.kind === 'lifecycle') {
      if (envelope.state === 'error' || envelope.state === 'stopped') append(logicalSessionId, 'runtime', { state: envelope.state, detail: envelope.detail ?? '' })
      return
    }
    if (envelope.kind !== 'notification') return
    const params = record(envelope.params)
    const runtimeThreadId = threadIdFrom(params)
    const turnId = turnIdFrom(params)
    const method = envelope.method
    const meta = { runtimeThreadId, turnId }

    if (method === 'item/started') {
      const item = record(params.item)
      const itemId = typeof item.id === 'string' ? item.id : ''
      const type = itemEventType(item.type)
      if (itemId && type) updateItem(logicalSessionId, itemId, type, () => startedItemPayload(item), meta)
      return
    }    if (method === 'item/agentMessage/delta') {
      const itemId = text(params.itemId, 256)
      if (itemId) updateItem(logicalSessionId, itemId, 'agentMessage', payload => ({ ...payload, phase: 'running', text: appendDelta(payload.text, params.delta) }), meta)
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const itemId = text(params.itemId, 256)
      if (itemId) updateItem(logicalSessionId, itemId, 'reasoning', payload => ({ ...payload, phase: 'running', text: appendDelta(payload.text, params.delta) }), meta)
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      const itemId = text(params.itemId, 256)
      if (itemId) updateItem(logicalSessionId, itemId, 'commandExecution', payload => ({ ...payload, phase: 'running', output: appendDelta(payload.output, params.delta) }), meta)
      return
    }
    if (method === 'item/fileChange/patchUpdated') {
      const itemId = text(params.itemId, 256)
      if (itemId) updateItem(logicalSessionId, itemId, 'fileChange', payload => ({ ...payload, phase: 'running', changes: params.changes }), meta)
      return
    }
    if (method === 'item/mcpToolCall/progress') {
      const itemId = text(params.itemId, 256)
      if (itemId) updateItem(logicalSessionId, itemId, 'mcpToolCall', payload => ({ ...payload, phase: 'running', progress: appendDelta(payload.progress, params.message, 12_000) }), meta)
      return
    }
    if (method === 'item/completed') {
      const item = record(params.item)
      const itemId = typeof item.id === 'string' ? item.id : ''
      const type = itemEventType(item.type)
      if (itemId && type) updateItem(logicalSessionId, itemId, type, previous => ({ ...previous, ...completedItemPayload(item) }), meta)
      return
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn)
      append(logicalSessionId, 'turnState', { status: turn.status ?? 'completed', error: turn.error ?? null }, { ...meta, turnId: typeof turn.id === 'string' ? turn.id : turnId })
    }
  },
  hydrateFromThread(logicalSessionId: string, response: unknown, runtimeThreadId?: string | null) {
    const root = record(response)
    const thread = record(root.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(root.turns) ? root.turns : []
    const existingIds = new Set(this.events(logicalSessionId).map(event => event.itemId).filter(Boolean))
    for (const rawTurn of turns) {
      const turn = record(rawTurn)
      const turnId = typeof turn.id === 'string' ? turn.id : undefined
      const items = Array.isArray(turn.items) ? turn.items : []
      for (const rawItem of items) {
        const item = record(rawItem)
        const itemId = typeof item.id === 'string' ? item.id : ''
        if (!itemId || existingIds.has(itemId)) continue
        const type = itemEventType(item.type)
        if (!type) continue
        append(logicalSessionId, type, completedItemPayload(item), { itemId, turnId, runtimeThreadId: runtimeThreadId ?? undefined })
        existingIds.add(itemId)
      }
      if (turnId && (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted')) {
        const hasTurn = this.events(logicalSessionId).some(event => event.type === 'turnState' && event.turnId === turnId)
        if (!hasTurn) append(logicalSessionId, 'turnState', { status: turn.status, error: turn.error ?? null }, { turnId, runtimeThreadId: runtimeThreadId ?? undefined })
      }
    }
    if (runtimeThreadId) this.setRuntimeThread(logicalSessionId, runtimeThreadId)
    return this.snapshot(logicalSessionId)
  },

  subscribe(logicalSessionId: string, listener: () => void) {
    const local = () => listener()
    const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) listener() }
    window.addEventListener(CHANGE_EVENT, local)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, local)
      window.removeEventListener('storage', storage)
    }
  }
}

export function migrateLegacyMessages(logicalSessionId: string, messages: LocalSessionMessage[]) {
  const session = { id: logicalSessionId, messages } as LocalSessionRecord
  return Zero3SessionEventStore.ensureMigrated(session)
}