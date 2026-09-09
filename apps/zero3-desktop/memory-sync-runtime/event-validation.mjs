// Kept aligned with schemas/zero3.memory.event.v1.schema.json by contract tests.
export const EVENT_TYPES = ['decision.recorded', 'decision.superseded', 'constraint.recorded', 'pitfall.recorded', 'pitfall.resolved', 'glossary.updated', 'policy.recorded', 'policy.revoked', 'focus.changed', 'fact.verified', 'fact.contradicted', 'task.created', 'task.requirement.updated', 'task.assigned', 'task.progress', 'task.blocked', 'task.unblocked', 'task.verified', 'task.completed', 'task.failed', 'handoff.published', 'artifact.recorded', 'sync.client_connected', 'sync.client_recovered', 'sync.conflict_detected', 'sync.offline_batch_ingested', 'memory.corrected', 'memory.superseded', 'memory.revoked']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max }
export function validatePublishEvent(event, projectId) {
  if (!object(event) || event.schema !== 'zero3.memory.event.v1' || !UUID.test(event.event_id ?? '')) throw new Error('invalid memory event identity')
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(event.created_at ?? '') || !Number.isFinite(Date.parse(event.created_at))) throw new Error('invalid event timestamp')
  if (!object(event.scope) || event.scope.project_id !== projectId) throw new Error('memory event project mismatch')
  for (const value of Object.values(event.scope)) if (value != null && !text(value, 256)) throw new Error('invalid memory scope')
  if (!object(event.actor) || !text(event.actor.agent_id, 256) || !['zero3', 'codex', 'claude', 'antigravity', 'gpt_web', 'system', 'migration'].includes(event.actor.agent_type)) throw new Error('invalid memory actor')
  if (!EVENT_TYPES.includes(event.event_type)) throw new Error('invalid event type')
  const memory = event.memory
  if (!object(memory) || !['project', 'task'].includes(memory.class) || !text(memory.entity_id, 256) || !text(memory.entity_type, 128)) throw new Error('invalid memory entity')
  if (memory.class === 'task' && !text(event.scope.task_id, 256)) throw new Error('task_id is required')
  if (!Number.isSafeInteger(memory.expected_entity_version) || memory.expected_entity_version < 0) throw new Error('expected_entity_version is required')
  if (!Number.isInteger(memory.authority) || memory.authority < 0 || memory.authority > 60) throw new Error('agent authority must be between 0 and 60')
  if (memory.confidence != null && (typeof memory.confidence !== 'number' || !Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1)) throw new Error('invalid confidence')
  if (!object(event.source) || !['task', 'chat', 'git', 'artifact', 'migration', 'system', 'github_inbox'].includes(event.source.type)) throw new Error('invalid memory source')
  if (!Array.isArray(event.supersedes) || event.supersedes.length > 64 || event.supersedes.some(id => !UUID.test(id))) throw new Error('invalid supersedes')
  if (!object(event.payload) || Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) throw new Error('memory event must contain an object payload and be at most 1 MiB')
}
