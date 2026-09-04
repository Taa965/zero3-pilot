export type Zero3VerificationState = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'BLOCKED'
export type Zero3VerificationEvidence = {
  id: string
  state: Zero3VerificationState
  command?: string | null
  exitCode?: number | null
  evidence?: string | null
  reason?: string | null
  checkedAt: string
}

export function normalizeVerification(value: Partial<Zero3VerificationEvidence>): Zero3VerificationEvidence {
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id || id.length > 256) throw new Error('verification id is invalid')
  const state = value.state
  if (!state || !['PASSED', 'FAILED', 'NOT_RUN', 'BLOCKED'].includes(state)) throw new Error('verification state is invalid')
  if (state === 'PASSED') {
    if (value.exitCode != null && value.exitCode !== 0) throw new Error('PASSED verification cannot have a non-zero exit code')
    if (!value.evidence?.trim() && value.exitCode == null) throw new Error('PASSED verification requires authoritative evidence or exitCode=0')
  }
  if (state === 'NOT_RUN' && !value.reason?.trim()) throw new Error('NOT_RUN verification requires a reason')
  if (state === 'BLOCKED' && !value.reason?.trim()) throw new Error('BLOCKED verification requires a reason')
  return {
    id,
    state,
    command: value.command?.trim() || null,
    exitCode: value.exitCode ?? null,
    evidence: value.evidence?.trim() || null,
    reason: value.reason?.trim() || null,
    checkedAt: value.checkedAt || new Date().toISOString()
  }
}

export type Zero3OutcomeReconciliation = {
  state: 'RUNNING' | 'PARTIAL' | 'FAILED' | 'RESULT_READY' | 'OUTCOME_UNKNOWN'
  reasons: string[]
}

export function reconcileOutcomeUnknown(input: {
  processAlive: boolean | null
  terminalResultSeen: boolean
  worktreeChanged: boolean | null
  artifactsPresent: boolean | null
  latestResultStatus?: string | null
}): Zero3OutcomeReconciliation {
  const reasons: string[] = []
  if (input.terminalResultSeen) {
    if (input.latestResultStatus === 'COMPLETE') return { state: 'RESULT_READY', reasons: ['terminal structured result is present'] }
    if (input.latestResultStatus === 'FAILED' || input.latestResultStatus === 'BLOCKED') return { state: 'FAILED', reasons: [`terminal result status=${input.latestResultStatus}`] }
  }
  if (input.processAlive === true) return { state: 'RUNNING', reasons: ['runtime process is still alive'] }
  if (input.worktreeChanged === true || input.artifactsPresent === true) {
    reasons.push(input.worktreeChanged === true ? 'worktree contains changes' : 'no worktree change was proven')
    reasons.push(input.artifactsPresent === true ? 'artifacts are present' : 'no artifact presence was proven')
    return { state: 'PARTIAL', reasons }
  }
  reasons.push('no terminal result was observed')
  if (input.processAlive === false) reasons.push('runtime process is not alive')
  return { state: 'OUTCOME_UNKNOWN', reasons }
}
