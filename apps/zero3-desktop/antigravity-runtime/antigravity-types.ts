export type Zero3AntigravityAuthState = 'UNKNOWN' | 'AUTHENTICATED' | 'AUTH_REQUIRED' | 'AUTH_EXPIRED'
export type Zero3AntigravityRuntimeState = 'STOPPED' | 'STARTING' | 'READY' | 'RUNNING' | 'OUTCOME_UNKNOWN' | 'ERROR'

export type Zero3AntigravitySessionBinding = {
  logicalSessionId: string
  projectId: string | null
  cwd: string
  conversationId: string | null
  state: Zero3AntigravityRuntimeState
  authState: Zero3AntigravityAuthState
  lastEventAt: string | null
  createdAt: string
  updatedAt: string
}

export type Zero3AntigravityTurnInput = {
  logicalSessionId: string
  projectId?: string | null
  cwd: string
  prompt: string
  taskId?: string | null
  contextVersion?: number | null
}

export type Zero3AntigravityMappedEvent = {
  eventId: string
  logicalSessionId: string
  taskId: string | null
  turnId: string | null
  conversationId: string | null
  at: string
  type:
    | 'agent.runtime.started'
    | 'agent.turn.started'
    | 'agent.response.delta'
    | 'agent.tool.started'
    | 'agent.tool.completed'
    | 'agent.subagent.started'
    | 'agent.subagent.completed'
    | 'agent.turn.completed'
    | 'agent.turn.failed'
    | 'agent.turn.outcome_unknown'
    | 'provider.auth.required'
    | 'provider.health.changed'
  payload: Record<string, unknown>
}

export type Zero3AntigravityTurnResult = {
  turnId: string
  logicalSessionId: string
  conversationId: string | null
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  response: string | null
  structuredOutput: unknown | null
  error: string | null
  rawStatus: string | null
}

export const ZERO3_GEMINI_EXECUTION_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'changedFiles', 'artifacts', 'verification', 'knownIssues', 'blockers', 'recommendedAction'],
  properties: {
    status: { enum: ['COMPLETE', 'PARTIAL', 'BLOCKED', 'FAILED'] },
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object' } },
    git: { type: ['object', 'null'] },
    verification: { type: 'array', items: { type: 'object' } },
    knownIssues: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    recommendedAction: { enum: ['GPT_REVIEW', 'HUMAN_REVIEW', 'CODEX_IMPLEMENT', 'RETRY'] }
  }
} as const
