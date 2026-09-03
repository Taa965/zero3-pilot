import { createHash } from 'node:crypto'

import type { DevelopmentFailureKind, DevelopmentSessionDefinition, FailureRecord } from '../contracts/index.ts'
import { classifyChangedPath } from '../workspace/index.ts'

export type FailureSignal =
  | 'environment_unavailable'
  | 'command_failed'
  | 'integration_conflict'
  | 'contract_mismatch'
  | 'dependency_failed'
  | 'test_only'
  | 'permission_denied'
  | 'outcome_unknown'
  | 'unknown'

export interface FailureObservation {
  groupId: string
  verificationRunId?: string
  signal: FailureSignal
  message: string
  evidence: readonly string[]
  changedPaths?: readonly string[]
  involvedSessionIds?: readonly string[]
  attempts?: number
}

function kindFor(signal: FailureSignal): DevelopmentFailureKind {
  switch (signal) {
    case 'environment_unavailable': return 'environment'
    case 'integration_conflict': return 'integration_seam'
    case 'contract_mismatch': return 'contract_mismatch'
    case 'dependency_failed': return 'dependency'
    case 'test_only': return 'test_only'
    case 'permission_denied': return 'permission'
    case 'outcome_unknown': return 'outcome_unknown'
    case 'command_failed': return 'implementation'
    case 'unknown': return 'unknown'
  }
}

function stableFailureId(observation: FailureObservation): string {
  const payload = JSON.stringify({ groupId: observation.groupId, verificationRunId: observation.verificationRunId, signal: observation.signal, message: observation.message, evidence: [...observation.evidence].sort(), changedPaths: [...(observation.changedPaths ?? [])].sort() })
  return `F-${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`
}

export function attributeFailure(observation: FailureObservation, sessions: readonly DevelopmentSessionDefinition[]): FailureRecord {
  const owners = new Set(observation.involvedSessionIds ?? [])
  for (const path of observation.changedPaths ?? []) {
    for (const session of sessions) {
      if (classifyChangedPath(path, session).authority === 'owned') owners.add(session.sessionId)
    }
  }
  const knownIds = new Set(sessions.map(session => session.sessionId))
  const ownerSessionIds = [...owners].filter(id => knownIds.has(id)).sort()
  return {
    failureId: stableFailureId(observation),
    groupId: observation.groupId,
    verificationRunId: observation.verificationRunId,
    kind: kindFor(observation.signal),
    message: observation.message.trim() || observation.signal,
    evidence: [...observation.evidence],
    ownerSessionIds,
    attempts: observation.attempts ?? 1,
    unresolved: true
  }
}
