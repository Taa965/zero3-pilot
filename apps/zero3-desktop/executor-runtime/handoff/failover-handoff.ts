import { buildHandoffCheckpoint } from './handoff-builder.ts'
import { HandoffStore } from './handoff-store.ts'
import type {
  ExecutorFailoverHandoffCapture,
  ExecutorFailoverHandoffRequest
} from '../executor-manager.ts'
import type { ExecutorHandoffCheckpointRef } from '../executor-types.ts'
import { ZERO3_HANDOFF_PROTOCOL } from '../executor-types.ts'

function constraintValue(constraints: readonly string[], prefix: string): string | undefined {
  const value = constraints.find(candidate => candidate.startsWith(prefix))?.slice(prefix.length).trim()
  return value || undefined
}

export class WorkspaceFailoverHandoffCapture {
  constructor(readonly store: HandoffStore) {}

  readonly capture: ExecutorFailoverHandoffCapture = async (
    request: ExecutorFailoverHandoffRequest
  ): Promise<ExecutorHandoffCheckpointRef> => {
    const baseSha = request.identity.baseSha?.trim() || constraintValue(request.identity.constraints, 'baseline=')
    if (!baseSha) throw new Error('checkpointed failover requires an authoritative baseline SHA')

    const checkpoint = await buildHandoffCheckpoint({
      taskId: request.identity.taskId,
      executionId: request.identity.executionId,
      workspace: request.identity.workspace,
      repoId: request.identity.repoIdentity?.trim() || request.identity.workspace,
      baseSha,
      objective: request.identity.objective,
      constraints: request.identity.constraints,
      acceptanceCriteria: request.identity.acceptanceCriteria,
      completed: [],
      inProgress: ['executor stopped before authoritative completion'],
      remaining: ['inspect the persisted workspace state and continue the objective'],
      testsRun: [],
      testResults: [],
      pendingApprovals: [],
      lastExecutor: request.session.executorId,
      lastSessionId: request.session.sessionId,
      stopReason: `executor_failure:${request.failure.code}`,
      nextAction: `continue_with:${request.targetExecutorId}`,
      previousGeneration: request.session.generation - 1
    })

    await this.store.save(checkpoint)
    const persisted = await this.store.load(
      request.identity.taskId,
      request.identity.executionId,
      checkpoint.handoff_generation
    )
    if (persisted.checkpoint_hash !== checkpoint.checkpoint_hash) {
      throw new Error('persisted failover checkpoint hash changed after durable write')
    }
    if (persisted.handoff_generation !== request.session.generation) {
      throw new Error('persisted failover checkpoint generation does not match the active writer')
    }
    if (persisted.dirty_worktree_fingerprint !== checkpoint.dirty_worktree_fingerprint) {
      throw new Error('persisted failover workspace fingerprint changed after durable write')
    }

    return {
      protocol: ZERO3_HANDOFF_PROTOCOL,
      checkpointHash: persisted.checkpoint_hash,
      generation: persisted.handoff_generation,
      workspaceFingerprint: persisted.dirty_worktree_fingerprint
    }
  }
}
