export const AGENT_MEMORY_ADAPTER_METHODS = Object.freeze([
  'prepareContext',
  'captureResult',
  'extractMemoryCandidates',
  'publishMemoryEvents',
  'publishHandoff'
])

export const CONTEXT_PRIORITY = Object.freeze({
  system_policy: 900,
  user_decision: 800,
  project_authority: 700,
  task_authority: 600,
  handoff: 550,
  verified_shared: 500,
  recent_shared: 400,
  native_working_memory: 300,
  semantic_history: 200,
  scratch: 100
})

export class AgentMemoryGovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AgentMemoryGovernanceError'
    this.code = code
    this.details = details
  }
}

export function assertAgentMemoryAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new AgentMemoryGovernanceError('invalid_adapter', 'agent memory adapter must be an object')
  }
  const missing = AGENT_MEMORY_ADAPTER_METHODS.filter(name => typeof adapter[name] !== 'function')
  if (missing.length) {
    throw new AgentMemoryGovernanceError('invalid_adapter', `agent memory adapter is missing: ${missing.join(', ')}`, { missing })
  }
  return adapter
}

function normalizeContextItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new AgentMemoryGovernanceError('invalid_context_item', `context item ${index} must be an object`)
  }
  const key = typeof item.key === 'string' ? item.key.trim() : ''
  const layer = typeof item.layer === 'string' ? item.layer : ''
  if (!key || !Object.hasOwn(CONTEXT_PRIORITY, layer)) {
    throw new AgentMemoryGovernanceError('invalid_context_item', `context item ${index} has invalid key/layer`)
  }
  const authority = Number.isInteger(item.authority) ? item.authority : 0
  const sequence = Number.isSafeInteger(item.sequence) && item.sequence >= 0 ? item.sequence : 0
  return { ...item, key, layer, authority, sequence, _priority: CONTEXT_PRIORITY[layer], _index: index }
}

export function resolveContext(items) {
  const winners = new Map()
  const staleNative = []
  items.map(normalizeContextItem).forEach(item => {
    const current = winners.get(item.key)
    if (!current) {
      winners.set(item.key, item)
      return
    }
    const comparison = compareContext(item, current)
    if (comparison > 0) {
      if (current.layer === 'native_working_memory') staleNative.push(current.key)
      winners.set(item.key, item)
    } else if (item.layer === 'native_working_memory') {
      staleNative.push(item.key)
    }
  })

  const ordered = [...winners.values()]
    .sort((a, b) => b._priority - a._priority || b.authority - a.authority || b.sequence - a.sequence || a._index - b._index)
    .map(({ _priority, _index, ...item }) => item)

  return { items: ordered, native_context_stale_items: [...new Set(staleNative)] }
}

function compareContext(a, b) {
  if (a._priority !== b._priority) return a._priority - b._priority
  if (a.authority !== b.authority) return a.authority - b.authority
  if (a.sequence !== b.sequence) return a.sequence - b.sequence
  return b._index - a._index
}

export function buildContextManifest({ projectId, taskId = null, projectSequence = 0, taskSequence = 0, resolved, retrievalItems = [], nativeContextUsed = false, generatedAt = new Date().toISOString() }) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new AgentMemoryGovernanceError('invalid_manifest', 'projectId is required')
  return {
    schema: 'zero3.memory.context-manifest.v1',
    project_id: projectId,
    task_id: taskId,
    project_sequence: projectSequence,
    task_sequence: taskSequence,
    authority_items: resolved.items.filter(item => item.layer !== 'native_working_memory' && item.layer !== 'semantic_history' && item.layer !== 'scratch').map(item => item.key),
    retrieval_items: retrievalItems.map(item => typeof item === 'string' ? item : item.key).filter(Boolean),
    native_context_used: Boolean(nativeContextUsed),
    native_context_stale_items: resolved.native_context_stale_items,
    generated_at: generatedAt
  }
}

export function enforcePromotionPolicy(candidate, policy = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AgentMemoryGovernanceError('invalid_candidate', 'memory candidate must be an object')
  }
  const proposedAuthority = Number.isInteger(candidate.proposed_authority) ? candidate.proposed_authority : 0
  const maxAuthority = Number.isInteger(policy.maxAuthority) ? policy.maxAuthority : 60
  if (proposedAuthority > maxAuthority || proposedAuthority >= 100) {
    throw new AgentMemoryGovernanceError('authority_escalation', 'agent cannot promote memory above its authority boundary', { proposedAuthority, maxAuthority })
  }
  const scope = candidate.scope ?? 'task'
  if (scope === 'personal') {
    throw new AgentMemoryGovernanceError('personal_auto_promotion_forbidden', 'personal memory requires a separate explicit approval boundary')
  }
  if (scope === 'global' && !policy.allowGlobal) {
    throw new AgentMemoryGovernanceError('global_promotion_forbidden', 'agent cannot automatically promote global memory')
  }
  if (scope === 'project' && candidate.candidate_type === 'inference' && candidate.verification_status !== 'verified') {
    throw new AgentMemoryGovernanceError('unverified_durable_memory', 'unverified inference cannot become durable project memory')
  }
  return { ...candidate, proposed_authority: proposedAuthority, scope }
}

export function promoteCandidates(candidates, policy = {}) {
  const accepted = []
  const rejected = []
  for (const candidate of candidates) {
    try {
      accepted.push(enforcePromotionPolicy(candidate, policy))
    } catch (error) {
      if (!(error instanceof AgentMemoryGovernanceError)) throw error
      rejected.push({ candidate, code: error.code, message: error.message })
    }
  }
  return { accepted, rejected }
}

export function assertFailoverFreshness({ handoffProjectSequence, currentProjectSequence, handoffTaskSequence, currentTaskSequence }) {
  const values = { handoffProjectSequence, currentProjectSequence, handoffTaskSequence, currentTaskSequence }
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AgentMemoryGovernanceError('invalid_sequence', `${name} must be a non-negative safe integer`)
  }
  const projectGap = currentProjectSequence - handoffProjectSequence
  const taskGap = currentTaskSequence - handoffTaskSequence
  if (projectGap > 0 || taskGap > 0) {
    throw new AgentMemoryGovernanceError('stale_handoff', 'replacement agent must catch up shared memory before executing', {
      projectGap: Math.max(projectGap, 0),
      taskGap: Math.max(taskGap, 0),
      requiredProjectSequence: currentProjectSequence,
      requiredTaskSequence: currentTaskSequence
    })
  }
  return true
}

export function buildFailoverHandoff(input) {
  const required = ['project_id', 'task_id', 'requirements', 'current_task_state', 'completed_work', 'remaining_work', 'verified_results', 'known_blockers', 'artifact_refs', 'commit_refs', 'workspace_ownership', 'project_authority_sequence', 'task_memory_sequence']
  const missing = required.filter(key => !Object.hasOwn(input ?? {}, key))
  if (missing.length) throw new AgentMemoryGovernanceError('invalid_handoff', `handoff is missing: ${missing.join(', ')}`, { missing })
  return {
    protocol: 'zero3.memory.handoff.v2',
    ...structuredClone(input)
  }
}

export function nativeMemoryPolicy(provider) {
  return Object.freeze({
    provider,
    role: 'working_memory_only',
    can_be_project_authority: false,
    can_be_task_authority: false,
    conflict_rule: 'zero3_authority_wins'
  })
}
