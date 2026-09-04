import type { Zero3RemoteTask } from './remote-types'

export const ZERO3_COMPLETION_EVIDENCE = {
  turnCompleted: 'codex.turn.completed',
  gitPreflight: 'git.preflight',
  gitPostflight: 'git.postflight',
  gitClean: 'git.clean',
  gitRemoteSynced: 'git.remote_synced',
  agentSummary: 'agent.summary',
  executionResult: 'execution.result'
} as const

export type Zero3CompletionGateInput = {
  task: Zero3RemoteTask
  turnStatus: string
  agentSummary: string | null
  gitPreflight: {
    headCommit: string
    baseCommit: string | null
    cleanWorktree: boolean | null
  }
  gitPostflight: {
    headCommit: string
    cleanWorktree: boolean | null
    upstreamCommit: string | null
    remoteSynced: boolean | null
  } | null
  evidenceMethods: string[]
}

export type Zero3CompletionGateResult = {
  ok: boolean
  required: string[]
  satisfied: string[]
  missing: string[]
  unsupported: string[]
}

const SUPPORTED = new Set(Object.values(ZERO3_COMPLETION_EVIDENCE))

function normalizeRequired(task: Zero3RemoteTask): string[] {
  const values = task.handoff?.required_evidence ?? []
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function hasExecutionResultEvidence(methods: string[]): boolean {
  return methods.includes('remote.execution.result')
}

export function evaluateZero3CompletionGate(input: Zero3CompletionGateInput): Zero3CompletionGateResult {
  const required = normalizeRequired(input.task)
  const unsupported = required.filter(value => !SUPPORTED.has(value as (typeof ZERO3_COMPLETION_EVIDENCE)[keyof typeof ZERO3_COMPLETION_EVIDENCE]))
  const satisfied: string[] = []
  const missing: string[] = []

  for (const requirement of required) {
    if (unsupported.includes(requirement)) continue
    let ok = false
    switch (requirement) {
      case ZERO3_COMPLETION_EVIDENCE.turnCompleted:
        ok = input.turnStatus === 'completed'
        break
      case ZERO3_COMPLETION_EVIDENCE.gitPreflight:
        ok = Boolean(input.gitPreflight.headCommit)
        break
      case ZERO3_COMPLETION_EVIDENCE.gitPostflight:
        ok = Boolean(input.gitPostflight?.headCommit)
        break
      case ZERO3_COMPLETION_EVIDENCE.gitClean:
        ok = input.gitPostflight?.cleanWorktree === true
        break
      case ZERO3_COMPLETION_EVIDENCE.gitRemoteSynced:
        ok = input.gitPostflight?.remoteSynced === true
        break
      case ZERO3_COMPLETION_EVIDENCE.agentSummary:
        ok = Boolean(input.agentSummary?.trim())
        break
      case ZERO3_COMPLETION_EVIDENCE.executionResult:
        ok = hasExecutionResultEvidence(input.evidenceMethods)
        break
    }
    if (ok) satisfied.push(requirement)
    else missing.push(requirement)
  }

  return {
    ok: missing.length === 0 && unsupported.length === 0,
    required,
    satisfied,
    missing,
    unsupported
  }
}
