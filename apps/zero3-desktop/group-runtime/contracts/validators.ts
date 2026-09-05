import {
  ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  ZERO3_GROUP_COMPLETION_PROOF,
  type DevelopmentDelivery,
  type DevelopmentGroupDefinition,
  type DevelopmentGroupPolicy,
  type DevelopmentGroupStatus,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionStatus,
  type DevelopmentWave,
  type GroupCompletionProof,
  type VerificationRun
} from './contract-types.ts'
import { isValidGroupTransition, isValidSessionTransition } from './state-machine.ts'

export interface ValidationIssue {
  code: string
  path: string
  message: string
}

const SHA_RE = /^[0-9a-f]{40}$/i

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message }
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validatePolicy(policy: DevelopmentGroupPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const [key, value] of [
    ['maxParallelSessions', policy.maxParallelSessions],
    ['maxSessionAttempts', policy.maxSessionAttempts],
    ['maxRepairSessions', policy.maxRepairSessions],
    ['maxRepairWaves', policy.maxRepairWaves],
    ['maxSameFailureAttempts', policy.maxSameFailureAttempts],
    ['maxSessionSubagents', policy.maxSessionSubagents]
  ] as const) {
    if (!positiveSafeInteger(value)) {
      issues.push(issue('invalid_budget', `policy.${key}`, `${key} must be a finite positive safe integer`))
    }
  }
  if (!nonEmpty(policy.targetBranch)) issues.push(issue('invalid_target_branch', 'policy.targetBranch', 'target branch is required'))
  if (!nonEmpty(policy.verificationPolicyRevision)) {
    issues.push(issue('invalid_verification_policy', 'policy.verificationPolicyRevision', 'verification policy revision is required'))
  }
  if (hasDuplicates(policy.protectedPaths)) issues.push(issue('duplicate_protected_path', 'policy.protectedPaths', 'protected paths must be unique'))
  if (hasDuplicates(policy.mandatoryTests)) issues.push(issue('duplicate_mandatory_test', 'policy.mandatoryTests', 'mandatory tests must be unique'))
  return issues
}

function findCycle<T extends string>(nodes: readonly T[], dependencies: (node: T) => readonly T[]): readonly T[] | undefined {
  const known = new Set(nodes)
  const visited = new Set<T>()
  const active = new Set<T>()
  const stack: T[] = []

  const visit = (node: T): readonly T[] | undefined => {
    if (active.has(node)) {
      const start = stack.indexOf(node)
      return [...stack.slice(start), node]
    }
    if (visited.has(node)) return undefined
    visited.add(node)
    active.add(node)
    stack.push(node)
    for (const dependency of dependencies(node)) {
      if (!known.has(dependency)) continue
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    active.delete(node)
    return undefined
  }

  for (const node of nodes) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return undefined
}

export function validateDevelopmentGroupDefinition(
  definition: DevelopmentGroupDefinition,
  requirements: readonly DevelopmentRequirement[],
  sessions: readonly DevelopmentSessionDefinition[],
  waves: readonly DevelopmentWave[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (definition.contract !== ZERO3_DEVELOPMENT_GROUP_CONTRACT) {
    issues.push(issue('unsupported_contract', 'contract', 'development group contract is unsupported'))
  }
  for (const [path, value] of [
    ['groupId', definition.groupId],
    ['repository', definition.repository],
    ['masterGoal', definition.masterGoal],
    ['masterPrompt', definition.masterPrompt],
    ['developmentPlan', definition.developmentPlan],
    ['planHash', definition.planHash],
    ['integrationRef', definition.integrationRef]
  ] as const) {
    if (!nonEmpty(value)) issues.push(issue('required', path, `${path} must be non-empty`))
  }
  if (!SHA_RE.test(definition.baselineSha)) issues.push(issue('invalid_baseline', 'baselineSha', 'baselineSha must be an exact 40-character Git SHA'))
  issues.push(...validatePolicy(definition.policy))

  if (hasDuplicates(definition.requirementIds)) issues.push(issue('duplicate_requirement', 'requirementIds', 'requirement ids must be unique'))
  if (hasDuplicates(definition.sessionIds)) issues.push(issue('duplicate_session', 'sessionIds', 'session ids must be unique'))
  if (hasDuplicates(definition.waveIds)) issues.push(issue('duplicate_wave', 'waveIds', 'wave ids must be unique'))

  const requirementById = new Map(requirements.map(item => [item.requirementId, item] as const))
  const sessionById = new Map(sessions.map(item => [item.sessionId, item] as const))
  const waveById = new Map(waves.map(item => [item.waveId, item] as const))

  for (const id of definition.requirementIds) {
    if (!requirementById.has(id)) issues.push(issue('missing_requirement', `requirementIds.${id}`, 'definition references a missing requirement'))
  }
  for (const id of definition.sessionIds) {
    if (!sessionById.has(id)) issues.push(issue('missing_session', `sessionIds.${id}`, 'definition references a missing session'))
  }
  for (const id of definition.waveIds) {
    if (!waveById.has(id)) issues.push(issue('missing_wave', `waveIds.${id}`, 'definition references a missing wave'))
  }

  for (const requirement of requirements) {
    if (requirement.groupId !== definition.groupId) issues.push(issue('group_mismatch', `requirements.${requirement.requirementId}.groupId`, 'requirement belongs to another group'))
    if (!nonEmpty(requirement.requirementId) || !nonEmpty(requirement.title) || !nonEmpty(requirement.description)) {
      issues.push(issue('invalid_requirement', `requirements.${requirement.requirementId}`, 'requirement id, title and description are required'))
    }
    if (requirement.acceptanceCriteria.length === 0 || requirement.acceptanceCriteria.some(value => !nonEmpty(value))) {
      issues.push(issue('missing_acceptance', `requirements.${requirement.requirementId}.acceptanceCriteria`, 'requirement needs non-empty acceptance criteria'))
    }
    if (!nonEmpty(requirement.sourceAnchor)) issues.push(issue('missing_source_anchor', `requirements.${requirement.requirementId}.sourceAnchor`, 'requirement source anchor is required'))
    if (hasDuplicates(requirement.dependencies)) issues.push(issue('duplicate_dependency', `requirements.${requirement.requirementId}.dependencies`, 'requirement dependencies must be unique'))
    for (const dependency of requirement.dependencies) {
      if (!requirementById.has(dependency)) issues.push(issue('unknown_dependency', `requirements.${requirement.requirementId}.dependencies`, `unknown requirement dependency ${dependency}`))
    }
  }

  const requirementCycle = findCycle(
    requirements.map(item => item.requirementId),
    id => requirementById.get(id)?.dependencies ?? []
  )
  if (requirementCycle) issues.push(issue('requirement_cycle', 'requirements', `requirement dependency cycle: ${requirementCycle.join(' -> ')}`))

  const assignmentCount = new Map<string, number>()
  const ownedPathOwner = new Map<string, string>()
  for (const session of sessions) {
    if (session.contract !== ZERO3_DEVELOPMENT_SESSION_CONTRACT) issues.push(issue('unsupported_contract', `sessions.${session.sessionId}.contract`, 'development session contract is unsupported'))
    if (session.groupId !== definition.groupId) issues.push(issue('group_mismatch', `sessions.${session.sessionId}.groupId`, 'session belongs to another group'))
    if (!nonEmpty(session.executionId) || !nonEmpty(session.objective) || !nonEmpty(session.branch) || !nonEmpty(session.worktree)) {
      issues.push(issue('invalid_session', `sessions.${session.sessionId}`, 'execution id, objective, branch and worktree are required'))
    }
    if (session.baselineSha !== definition.baselineSha || !SHA_RE.test(session.baselineSha)) issues.push(issue('invalid_baseline', `sessions.${session.sessionId}.baselineSha`, 'session baseline must equal the exact group baseline'))
    if (session.integrationRef !== definition.integrationRef) issues.push(issue('integration_ref_mismatch', `sessions.${session.sessionId}.integrationRef`, 'session integration ref must equal the group integration ref'))
    if (!waveById.has(session.waveId)) issues.push(issue('unknown_wave', `sessions.${session.sessionId}.waveId`, `unknown wave ${session.waveId}`))
    if (hasDuplicates(session.dependencies)) issues.push(issue('duplicate_dependency', `sessions.${session.sessionId}.dependencies`, 'session dependencies must be unique'))
    for (const dependency of session.dependencies) {
      if (!sessionById.has(dependency)) issues.push(issue('unknown_dependency', `sessions.${session.sessionId}.dependencies`, `unknown session dependency ${dependency}`))
      if (dependency === session.sessionId) issues.push(issue('self_dependency', `sessions.${session.sessionId}.dependencies`, 'session cannot depend on itself'))
    }
    if (!positiveSafeInteger(session.subagentPolicy.maxConcurrency)) issues.push(issue('invalid_budget', `sessions.${session.sessionId}.subagentPolicy.maxConcurrency`, 'subagent concurrency must be a finite positive safe integer'))
    if (session.subagentPolicy.maxConcurrency > definition.policy.maxSessionSubagents) issues.push(issue('subagent_budget_exceeded', `sessions.${session.sessionId}.subagentPolicy.maxConcurrency`, 'session subagent concurrency exceeds the group policy'))
    if (session.subagentPolicy.recursiveGroupCreation !== false) issues.push(issue('recursive_group_forbidden', `sessions.${session.sessionId}.subagentPolicy.recursiveGroupCreation`, 'Development Group cannot recursively create another group'))

    const allPathSets = [session.ownedPaths, session.readOnlyPaths, session.forbiddenPaths]
    for (const paths of allPathSets) {
      if (paths.some(path => !nonEmpty(path))) issues.push(issue('invalid_ownership', `sessions.${session.sessionId}`, 'ownership paths must be non-empty'))
      if (hasDuplicates(paths)) issues.push(issue('invalid_ownership', `sessions.${session.sessionId}`, 'each ownership path set must be unique'))
    }
    const localSeen = new Set<string>()
    for (const [kind, paths] of [
      ['owned', session.ownedPaths],
      ['read_only', session.readOnlyPaths],
      ['forbidden', session.forbiddenPaths]
    ] as const) {
      for (const path of paths) {
        if (localSeen.has(path)) issues.push(issue('invalid_ownership', `sessions.${session.sessionId}.${kind}`, `path ${path} appears in multiple ownership classes`))
        localSeen.add(path)
      }
    }
    for (const path of session.ownedPaths) {
      const existing = ownedPathOwner.get(path)
      if (existing && existing !== session.sessionId) issues.push(issue('ownership_collision', `sessions.${session.sessionId}.ownedPaths`, `path ${path} is also owned by ${existing}`))
      ownedPathOwner.set(path, session.sessionId)
    }

    for (const requirementId of session.requirements) {
      if (!requirementById.has(requirementId)) issues.push(issue('unknown_requirement', `sessions.${session.sessionId}.requirements`, `unknown requirement ${requirementId}`))
      assignmentCount.set(requirementId, (assignmentCount.get(requirementId) ?? 0) + 1)
    }
  }

  const sessionCycle = findCycle(
    sessions.map(item => item.sessionId),
    id => sessionById.get(id)?.dependencies ?? []
  )
  if (sessionCycle) issues.push(issue('session_cycle', 'sessions', `session dependency cycle: ${sessionCycle.join(' -> ')}`))

  for (const requirement of requirements) {
    const count = assignmentCount.get(requirement.requirementId) ?? 0
    if (requirement.mandatory && count !== 1) issues.push(issue('mandatory_assignment', `requirements.${requirement.requirementId}`, `mandatory requirement must be assigned exactly once; got ${count}`))
    if (count > 1) issues.push(issue('duplicate_assignment', `requirements.${requirement.requirementId}`, 'requirement cannot be owned by multiple sessions'))
  }

  for (const wave of waves) {
    if (wave.groupId !== definition.groupId) issues.push(issue('group_mismatch', `waves.${wave.waveId}.groupId`, 'wave belongs to another group'))
    if (!positiveSafeInteger(wave.ordinal)) issues.push(issue('invalid_wave', `waves.${wave.waveId}.ordinal`, 'wave ordinal must be a positive safe integer'))
    if (hasDuplicates(wave.sessionIds) || hasDuplicates(wave.requiredSessionIds) || hasDuplicates(wave.dependsOnWaveIds)) {
      issues.push(issue('duplicate_wave_member', `waves.${wave.waveId}`, 'wave members and dependencies must be unique'))
    }
    for (const sessionId of wave.sessionIds) {
      const session = sessionById.get(sessionId)
      if (!session) issues.push(issue('unknown_session', `waves.${wave.waveId}.sessionIds`, `unknown session ${sessionId}`))
      else if (session.waveId !== wave.waveId) issues.push(issue('wave_session_mismatch', `waves.${wave.waveId}.sessionIds`, `session ${sessionId} declares wave ${session.waveId}`))
    }
    for (const sessionId of wave.requiredSessionIds) {
      if (!wave.sessionIds.includes(sessionId)) issues.push(issue('invalid_required_session', `waves.${wave.waveId}.requiredSessionIds`, `${sessionId} is not in this wave`))
    }
    for (const dependency of wave.dependsOnWaveIds) {
      if (!waveById.has(dependency)) issues.push(issue('unknown_dependency', `waves.${wave.waveId}.dependsOnWaveIds`, `unknown wave dependency ${dependency}`))
      if (dependency === wave.waveId) issues.push(issue('self_dependency', `waves.${wave.waveId}.dependsOnWaveIds`, 'wave cannot depend on itself'))
    }
  }

  const waveCycle = findCycle(
    waves.map(item => item.waveId),
    id => waveById.get(id)?.dependsOnWaveIds ?? []
  )
  if (waveCycle) issues.push(issue('wave_cycle', 'waves', `wave dependency cycle: ${waveCycle.join(' -> ')}`))

  return issues
}

export function validateDevelopmentDelivery(delivery: DevelopmentDelivery, session: DevelopmentSessionDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (delivery.contract !== ZERO3_DEVELOPMENT_DELIVERY_CONTRACT) issues.push(issue('unsupported_contract', 'delivery.contract', 'development delivery contract is unsupported'))
  if (delivery.groupId !== session.groupId || delivery.sessionId !== session.sessionId || delivery.executionId !== session.executionId) issues.push(issue('identity_mismatch', 'delivery', 'delivery identity must match the Development Session'))
  if (delivery.baseSha !== session.baselineSha || !SHA_RE.test(delivery.baseSha)) issues.push(issue('invalid_baseline', 'delivery.baseSha', 'delivery base must match the session baseline'))
  if (!SHA_RE.test(delivery.headSha) || delivery.headSha === delivery.baseSha) issues.push(issue('invalid_head', 'delivery.headSha', 'delivery needs a distinct exact head SHA'))
  if (!nonEmpty(delivery.deliveryHash)) issues.push(issue('missing_delivery_hash', 'delivery.deliveryHash', 'delivery hash is required'))
  if (hasDuplicates(delivery.changedPaths)) issues.push(issue('duplicate_changed_path', 'delivery.changedPaths', 'changed paths must be unique'))
  if (hasDuplicates(delivery.requirements)) issues.push(issue('duplicate_requirement', 'delivery.requirements', 'delivered requirements must be unique'))
  for (const requirement of delivery.requirements) {
    if (!session.requirements.includes(requirement)) issues.push(issue('scope_violation', 'delivery.requirements', `session does not own requirement ${requirement}`))
  }
  return issues
}

export function validateGroupCompletionProof(
  proof: GroupCompletionProof,
  requirements: readonly DevelopmentRequirement[],
  deliveries: readonly DevelopmentDelivery[],
  verificationRuns: readonly VerificationRun[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (proof.contract !== ZERO3_GROUP_COMPLETION_PROOF) issues.push(issue('unsupported_contract', 'proof.contract', 'completion proof contract is unsupported'))
  if (!SHA_RE.test(proof.finalIntegrationSha)) issues.push(issue('invalid_integration_sha', 'proof.finalIntegrationSha', 'completion proof requires an exact integration SHA'))
  if (proof.integrationStatus !== 'clean') issues.push(issue('integration_not_clean', 'proof.integrationStatus', 'completion requires a clean integration'))
  if (proof.verificationStatus !== 'passed') issues.push(issue('verification_not_passed', 'proof.verificationStatus', 'completion requires passed verification'))
  if (proof.unresolvedBlockers.length > 0) issues.push(issue('unresolved_blocker', 'proof.unresolvedBlockers', 'completion cannot contain unresolved blockers'))
  if (proof.outcomeUnknownCount !== 0) issues.push(issue('outcome_unknown', 'proof.outcomeUnknownCount', 'completion cannot contain OutcomeUnknown'))
  if (!nonEmpty(proof.completionPolicyRevision)) issues.push(issue('missing_policy_revision', 'proof.completionPolicyRevision', 'completion policy revision is required'))

  const coverage = new Map(proof.requirementCoverage.map(item => [item.requirementId, item] as const))
  for (const requirement of requirements) {
    if (!requirement.mandatory) continue
    const record = coverage.get(requirement.requirementId)
    if (!record) {
      issues.push(issue('missing_requirement_coverage', `proof.requirementCoverage.${requirement.requirementId}`, 'mandatory requirement has no completion coverage'))
      continue
    }
    if (record.state !== 'verified' && record.state !== 'waived') issues.push(issue('mandatory_unverified', `proof.requirementCoverage.${requirement.requirementId}`, `mandatory requirement is ${record.state}`))
    if (record.state === 'waived' && (!record.waiver || !nonEmpty(record.waiver.approvedBy) || !nonEmpty(record.waiver.reason) || record.waiver.evidence.length === 0)) {
      issues.push(issue('invalid_waiver', `proof.requirementCoverage.${requirement.requirementId}.waiver`, 'waiver requires approver, reason and evidence'))
    }
  }

  const deliveryByHash = new Map(deliveries.map(item => [item.deliveryHash, item] as const))
  for (const coverageRecord of proof.sessionDeliveryCoverage) {
    const delivery = deliveryByHash.get(coverageRecord.deliveryHash)
    if (!coverageRecord.valid || !delivery || delivery.status !== 'completed') issues.push(issue('invalid_delivery', `proof.sessionDeliveryCoverage.${coverageRecord.sessionId}`, 'completion references an invalid or non-completed delivery'))
  }

  const verificationById = new Map(verificationRuns.map(item => [item.verificationRunId, item] as const))
  if (proof.verificationEvidence.length === 0) issues.push(issue('missing_verification_evidence', 'proof.verificationEvidence', 'completion requires verification evidence'))
  for (const verificationRunId of proof.verificationEvidence) {
    const run = verificationById.get(verificationRunId)
    if (!run || run.status !== 'passed' || run.integrationSha !== proof.finalIntegrationSha) {
      issues.push(issue('invalid_verification_evidence', `proof.verificationEvidence.${verificationRunId}`, 'verification evidence must be passed and bound to the final integration SHA'))
    }
  }
  return issues
}

export function validateGroupStateTransition(from: DevelopmentGroupStatus, to: DevelopmentGroupStatus): ValidationIssue[] {
  return isValidGroupTransition(from, to) ? [] : [issue('invalid_state_transition', 'group.status', `cannot transition Development Group from ${from} to ${to}`)]
}

export function validateSessionStateTransition(from: DevelopmentSessionStatus, to: DevelopmentSessionStatus): ValidationIssue[] {
  return isValidSessionTransition(from, to) ? [] : [issue('invalid_state_transition', 'session.status', `cannot transition Development Session from ${from} to ${to}`)]
}
