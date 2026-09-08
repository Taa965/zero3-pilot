import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { buildHandoffCheckpoint } from '../../executor-runtime/handoff/handoff-builder.ts'
import { HandoffStore } from '../../executor-runtime/handoff/handoff-store.ts'
import type { Zero3HandoffCheckpointV1 } from '../../executor-runtime/handoff/handoff-types.ts'
import {
  ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
  type DevelopmentDelivery,
  type DevelopmentGroupDefinition,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime
} from '../contracts/index.ts'
import { auditChangedPathOwnership, computeDeliveryHash, GitWorkspaceAdapter, type DeliveryHandoffEvidence } from '../workspace/index.ts'
import type { RuntimeHandoffEvidenceResolver } from './delivery-verifier.ts'

export interface RuntimeDeliveryMaterializerPort {
  materialize(group: DevelopmentGroupDefinition, session: DevelopmentSessionDefinition, runtime: DevelopmentSessionRuntime): Promise<DevelopmentDelivery>
}

export interface WorkspaceDeliveryMaterializerOptions {
  materializeDirtyExecutorIds?: readonly string[]
}

export class WorkspaceDeliveryMaterializer implements RuntimeDeliveryMaterializerPort {
  readonly #materializeDirtyExecutorIds: Set<string>

  constructor(readonly handoffStore: HandoffStore, options: WorkspaceDeliveryMaterializerOptions = {}) {
    const ids = options.materializeDirtyExecutorIds ?? []
    if (ids.some(id => !id.trim() || /[\0\r\n]/u.test(id))) throw new Error('materializeDirtyExecutorIds contains an invalid executor id')
    this.#materializeDirtyExecutorIds = new Set(ids)
  }

  private async materializeControllerCommit(
    group: DevelopmentGroupDefinition,
    session: DevelopmentSessionDefinition,
    runtime: DevelopmentSessionRuntime,
    git: GitWorkspaceAdapter
  ): Promise<void> {
    const status = await git.status()
    if (status.length === 0 || !runtime.executorId || !this.#materializeDirtyExecutorIds.has(runtime.executorId)) return
    if (session.executorPolicy.permissionProfile === 'read_only') throw new Error('read-only executor left a dirty worktree')

    const branch = await git.currentBranch()
    if (branch !== session.branch) throw new Error(`controller commit branch mismatch: expected ${session.branch}, got ${branch}`)
    const currentHead = await git.resolveHead()
    if (!(await git.isAncestor(session.baselineSha, currentHead))) throw new Error('controller commit HEAD is not descended from the frozen baseline')

    const committedAudit = auditChangedPathOwnership(await git.changedPaths(session.baselineSha, currentHead), session)
    if (!committedAudit.valid) throw new Error(`controller commit found existing ownership violation: ${committedAudit.violations.map(item => `${item.path}=${item.authority}`).join(', ')}`)
    const dirtyPaths = [...new Set(status.flatMap(entry => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]))].sort()
    const dirtyAudit = auditChangedPathOwnership(dirtyPaths, session)
    if (!dirtyAudit.valid) throw new Error(`controller commit refused dirty ownership violation: ${dirtyAudit.violations.map(item => `${item.path}=${item.authority}`).join(', ')}`)
    const preStaged = status.filter(entry => entry.status[0] !== ' ' && entry.status[0] !== '?')
    if (preStaged.length > 0) throw new Error(`controller commit refuses pre-staged index changes: ${preStaged.map(entry => entry.path).join(', ')}`)

    await git.stagePaths(dirtyPaths)
    try {
      const stagedPaths = await git.stagedPaths()
      if (stagedPaths.length === 0) throw new Error('controller commit has no staged changes after dirty worktree staging')
      const stagedAudit = auditChangedPathOwnership(stagedPaths, session)
      if (!stagedAudit.valid) throw new Error(`controller commit staged ownership violation: ${stagedAudit.violations.map(item => `${item.path}=${item.authority}`).join(', ')}`)
      await git.commit(`zero3: materialize ${group.groupId}/${session.sessionId} ${runtime.executorId} delivery`)
    } catch (error) {
      try { await git.unstagePaths(dirtyPaths) } catch {}
      throw error
    }
  }

  async materialize(group: DevelopmentGroupDefinition, session: DevelopmentSessionDefinition, runtime: DevelopmentSessionRuntime): Promise<DevelopmentDelivery> {
    if (runtime.groupId !== group.groupId || runtime.sessionId !== session.sessionId || runtime.executionId !== session.executionId) {
      throw new Error('Delivery materialization identity mismatch')
    }
    if (runtime.status !== 'delivering') throw new Error(`Delivery materialization requires delivering Session; got ${runtime.status}`)
    if (!runtime.executorId || !runtime.executorSessionId) throw new Error('Delivery materialization requires the bound Executor identity')

    const git = new GitWorkspaceAdapter(session.worktree)
    await this.materializeControllerCommit(group, session, runtime, git)
    const headSha = await git.resolveHead()
    const [changedPaths, status] = await Promise.all([
      git.changedPaths(session.baselineSha, headSha),
      git.status()
    ])
    if (session.deliveryPolicy.requireCleanHead && status.length > 0) throw new Error('Delivery materialization requires a clean committed worktree')

    const checkpoint = await buildHandoffCheckpoint({
      taskId: `${group.groupId}:${session.sessionId}`,
      executionId: session.executionId,
      workspace: session.worktree,
      repoId: group.repository,
      baseSha: session.baselineSha,
      objective: session.objective,
      constraints: [
        `integration_ref=${session.integrationRef}`,
        ...session.ownedPaths.map(path => `owned:${path}`),
        ...session.readOnlyPaths.map(path => `read_only:${path}`),
        ...session.forbiddenPaths.map(path => `forbidden:${path}`)
      ],
      acceptanceCriteria: session.acceptanceCriteria,
      completed: ['executor turn completed'],
      inProgress: [],
      remaining: ['Delivery validation', 'integration', 'verification'],
      testsRun: [],
      testResults: [],
      pendingApprovals: [],
      lastExecutor: runtime.executorId,
      lastSessionId: runtime.executorSessionId,
      stopReason: 'executor_completed',
      nextAction: 'validate_and_integrate_delivery',
      previousGeneration: Math.max(0, runtime.writerGeneration - 1)
    })
    await this.handoffStore.save(checkpoint)

    const draft: DevelopmentDelivery = {
      contract: ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
      groupId: group.groupId,
      sessionId: session.sessionId,
      executionId: session.executionId,
      status: 'completed',
      baseSha: session.baselineSha,
      headSha,
      changedPaths,
      requirements: session.requirements,
      testsAdded: [],
      testsExecuted: [],
      artifacts: [],
      knownIssues: [],
      downstreamNotes: [],
      handoffCheckpoint: checkpoint.checkpoint_hash,
      deliveryHash: '',
      createdAt: new Date().toISOString()
    }
    draft.deliveryHash = computeDeliveryHash(draft)
    return draft
  }
}

export class HandoffStoreEvidenceResolver implements RuntimeHandoffEvidenceResolver {
  constructor(readonly store: HandoffStore) {}

  async resolve(session: DevelopmentSessionDefinition, delivery: DevelopmentDelivery): Promise<DeliveryHandoffEvidence | undefined> {
    const expectedHash = delivery.handoffCheckpoint?.trim()
    if (!expectedHash) return undefined
    const taskId = `${session.groupId}:${session.sessionId}`
    const generationDirectory = dirname(this.store.checkpointPath(taskId, session.executionId, 1))
    let names: string[]
    try {
      names = await readdir(generationDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    for (const name of names.filter(value => /^handoff-\d+\.json$/u.test(value)).sort()) {
      const generation = Number(name.slice('handoff-'.length, -'.json'.length))
      if (!Number.isSafeInteger(generation) || generation < 1) continue
      let checkpoint: Zero3HandoffCheckpointV1
      try {
        checkpoint = await this.store.load(taskId, session.executionId, generation)
      } catch {
        continue
      }
      if (checkpoint.checkpoint_hash === expectedHash) return { checkpoint }
    }
    return undefined
  }
}
