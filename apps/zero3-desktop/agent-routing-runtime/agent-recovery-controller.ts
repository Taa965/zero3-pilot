import type { Zero3AntigravityAdapter } from '../antigravity-runtime/antigravity-adapter'
import { reconcileOutcomeUnknown, type Zero3OutcomeReconciliation } from '../artifact-runtime/verification'
import type { Zero3GitEvidence } from './git-authority'
import { Zero3AgentTaskStore, type Zero3AgentTaskRecord } from './agent-task-store'

export type Zero3RecoveryResolution = 'KEEP_UNKNOWN' | 'ACCEPT_PARTIAL' | 'MARK_FAILED'

export type Zero3AgentRecoverySnapshot = {
  taskId: string
  executionId: string
  logicalSessionId: string | null
  runtimeConversationId: string | null
  runtimeAlive: boolean | null
  artifactsPresent: boolean | null
  git: Zero3GitEvidence | null
  reconciliation: Zero3OutcomeReconciliation
  inspectedAt: string
}

export type Zero3AgentRecoveryDependencies = {
  taskStore: Zero3AgentTaskStore
  antigravity: Pick<Zero3AntigravityAdapter, 'status' | 'binding'>
  collectGitEvidence: (workspace: string, requestedBaseSha?: string | null) => Promise<Zero3GitEvidence>
  artifactsPresent: (taskId: string) => Promise<boolean>
  audit?: (entry: Record<string, unknown>) => Promise<void> | void
}

function rationale(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 8_000) throw new Error('recovery rationale is required and must be <= 8000 characters')
  return text
}

export class Zero3AgentRecoveryController {
  constructor(private readonly deps: Zero3AgentRecoveryDependencies) {}

  async inspect(taskId: string): Promise<Zero3AgentRecoverySnapshot> {
    const record = await this.requireUnknown(taskId)
    const logicalSessionId = record.binding?.targetLogicalSessionId ?? null
    const runtimeConversationId = record.binding?.runtimeConversationId ?? record.result?.conversationId ?? null

    let runtimeAlive: boolean | null = null
    if (record.resolvedTarget === 'GEMINI' && logicalSessionId) {
      const status = this.deps.antigravity.status()
      runtimeAlive = status.activeSessions.includes(logicalSessionId)
      const binding = await this.deps.antigravity.binding(logicalSessionId)
      if (binding?.state === 'RUNNING') runtimeAlive = true
      if (binding?.state === 'OUTCOME_UNKNOWN' || binding?.state === 'STOPPED' || binding?.state === 'ERROR') runtimeAlive = false
    }

    let git: Zero3GitEvidence | null = null
    if (record.task.worktreePath?.trim()) {
      try {
        git = await this.deps.collectGitEvidence(record.task.worktreePath, record.task.baseSha ?? null)
      } catch {
        git = null
      }
    }

    let artifactsPresent: boolean | null = null
    try {
      artifactsPresent = await this.deps.artifactsPresent(record.task.taskId)
    } catch {
      artifactsPresent = null
    }

    const terminalResultSeen = Boolean(record.result && record.result.status !== 'OUTCOME_UNKNOWN')
    const reconciliation = reconcileOutcomeUnknown({
      processAlive: runtimeAlive,
      terminalResultSeen,
      worktreeChanged: git ? !git.clean || git.headSha !== (git.baseSha ?? git.headSha) : null,
      artifactsPresent,
      latestResultStatus: record.result?.status ?? null
    })

    const snapshot: Zero3AgentRecoverySnapshot = {
      taskId: record.task.taskId,
      executionId: record.task.executionId,
      logicalSessionId,
      runtimeConversationId,
      runtimeAlive,
      artifactsPresent,
      git,
      reconciliation,
      inspectedAt: new Date().toISOString()
    }
    await this.audit('inspect', record, snapshot)
    return snapshot
  }

  async applyResolution(
    taskId: string,
    resolution: Zero3RecoveryResolution,
    rationaleValue: unknown
  ): Promise<Zero3AgentTaskRecord> {
    const reason = rationale(rationaleValue)
    const before = await this.requireUnknown(taskId)
    const snapshot = await this.inspect(taskId)

    if (resolution === 'ACCEPT_PARTIAL') {
      if (!['PARTIAL', 'RESULT_READY'].includes(snapshot.reconciliation.state)) {
        throw new Error(`authoritative evidence does not support partial recovery; reconciliation=${snapshot.reconciliation.state}`)
      }
      const next = before.task.reviewPolicy.required ? 'REVIEW_PENDING' : 'RESULT_READY'
      const record = await this.deps.taskStore.setState(taskId, next)
      await this.audit('resolve', record, { resolution, rationale: reason, snapshot })
      return record
    }

    if (resolution === 'MARK_FAILED') {
      if (snapshot.runtimeAlive === true) throw new Error('cannot mark failed while the bound runtime is still active')
      const record = await this.deps.taskStore.setState(taskId, 'FAILED')
      await this.audit('resolve', record, { resolution, rationale: reason, snapshot })
      return record
    }

    const record = await this.deps.taskStore.setState(taskId, 'OUTCOME_UNKNOWN')
    await this.audit('resolve', record, { resolution, rationale: reason, snapshot })
    return record
  }

  async assertRetryAllowed(taskId: string): Promise<void> {
    const record = await this.deps.taskStore.get(taskId)
    if (!record) throw new Error('agent task record not found')
    if (record.state === 'OUTCOME_UNKNOWN') {
      throw new Error('automatic retry is forbidden while OutcomeUnknown is unresolved; inspect and explicitly classify authoritative evidence first')
    }
  }

  private async requireUnknown(taskId: string): Promise<Zero3AgentTaskRecord> {
    const record = await this.deps.taskStore.get(taskId)
    if (!record) throw new Error('agent task record not found')
    if (record.state !== 'OUTCOME_UNKNOWN' && record.result?.status !== 'OUTCOME_UNKNOWN') {
      throw new Error('recovery controller only accepts OutcomeUnknown tasks')
    }
    return record
  }

  private async audit(action: string, record: Zero3AgentTaskRecord, detail: unknown) {
    if (!this.deps.audit) return
    await this.deps.audit({
      protocol: 'zero3.pilot.agent-recovery-audit.v1',
      action,
      taskId: record.task.taskId,
      executionId: record.task.executionId,
      at: new Date().toISOString(),
      detail
    })
  }
}
