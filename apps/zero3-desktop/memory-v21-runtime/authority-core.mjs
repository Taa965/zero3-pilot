const USER_AUTHORITY = 100

export class MemoryConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MemoryConflictError'
    this.code = code
    this.details = details
  }
}

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('memory event must be an object')
  if (event.schema !== 'zero3.memory.event.v1') throw new TypeError('unsupported memory event schema')
  if (typeof event.event_id !== 'string' || !event.event_id) throw new TypeError('event_id is required')
  if (!event.memory || typeof event.memory !== 'object') throw new TypeError('memory metadata is required')
  if (!Number.isInteger(event.memory.authority) || event.memory.authority < 0 || event.memory.authority > 100) {
    throw new TypeError('memory authority must be an integer from 0 to 100')
  }
  if (typeof event.memory.entity_id !== 'string' || !event.memory.entity_id) throw new TypeError('memory entity_id is required')
  if (typeof event.memory.entity_type !== 'string' || !event.memory.entity_type) throw new TypeError('memory entity_type is required')
  if (!event.actor || typeof event.actor.agent_id !== 'string' || !event.actor.agent_id) throw new TypeError('actor.agent_id is required')
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

export class MemoryAuthorityState {
  #sequence = 0
  #events = new Map()
  #entities = new Map()

  get latestSequence() {
    return this.#sequence
  }

  getEvent(eventId) {
    return clone(this.#events.get(eventId) ?? null)
  }

  getEntity(entityId) {
    return clone(this.#entities.get(entityId) ?? null)
  }

  listEventsAfter(sequence, predicate = () => true) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('sequence must be a non-negative safe integer')
    return [...this.#events.values()]
      .filter(item => item.sequence > sequence && predicate(item.event))
      .sort((a, b) => a.sequence - b.sequence)
      .map(clone)
  }

  append(event) {
    assertEvent(event)
    const duplicate = this.#events.get(event.event_id)
    if (duplicate) return { status: 'duplicate', sequence: duplicate.sequence, entity: this.getEntity(event.memory.entity_id) }

    const entityId = event.memory.entity_id
    const current = this.#entities.get(entityId) ?? null
    const expected = event.memory.expected_entity_version ?? null

    if (expected !== null) {
      if (!Number.isSafeInteger(expected) || expected < 0) throw new TypeError('expected_entity_version must be null or a non-negative safe integer')
      const actual = current?.version ?? 0
      if (expected !== actual) {
        throw new MemoryConflictError('entity_version_conflict', `expected entity version ${expected}, current ${actual}`, {
          entity_id: entityId,
          expected_version: expected,
          current_version: actual
        })
      }
    }

    if (current && event.memory.authority < current.authority) {
      throw new MemoryConflictError('authority_conflict', 'lower-authority event cannot replace current authoritative entity', {
        entity_id: entityId,
        incoming_authority: event.memory.authority,
        current_authority: current.authority
      })
    }

    if (event.memory.authority === USER_AUTHORITY && event.actor.agent_type !== 'system') {
      throw new MemoryConflictError('user_authority_boundary', 'agents cannot self-assert user authority', {
        entity_id: entityId,
        actor_type: event.actor.agent_type
      })
    }

    const sequence = ++this.#sequence
    const version = (current?.version ?? 0) + 1
    const verificationStatus = event.event_type.endsWith('.revoked') ? 'revoked'
      : event.event_type.endsWith('.superseded') ? 'superseded'
      : event.event_type === 'fact.contradicted' ? 'contradicted'
      : event.event_type === 'fact.verified' || event.event_type === 'task.verified' ? 'verified'
      : 'unverified'

    const entity = {
      entity_id: entityId,
      entity_type: event.memory.entity_type,
      project_id: event.scope?.project_id ?? null,
      task_id: event.scope?.task_id ?? null,
      memory_class: event.memory.class,
      authority: event.memory.authority,
      confidence: event.memory.confidence ?? null,
      verification_status: verificationStatus,
      content: clone(event.payload),
      source_event_id: event.event_id,
      version,
      updated_sequence: sequence,
      updated_at: event.created_at
    }

    this.#events.set(event.event_id, { sequence, event: clone(event) })
    this.#entities.set(entityId, entity)
    return { status: 'accepted', sequence, entity: clone(entity) }
  }
}

export function authorityName(level) {
  if (level >= 100) return 'user_decision'
  if (level >= 95) return 'policy'
  if (level >= 85) return 'verified_result'
  if (level >= 80) return 'merged_main_fact'
  if (level >= 60) return 'agent_decision'
  if (level >= 45) return 'agent_observation'
  if (level >= 40) return 'external_observation'
  if (level >= 20) return 'inference'
  return 'unverified_note'
}
