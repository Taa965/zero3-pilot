import type {
  ExecutorEvent,
  ExecutorHandoffCheckpointRef,
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorPolicyContext,
  ExecutorSession,
  ExecutorSessionRef,
  ExecutorTaskIdentity
} from '../../executor-runtime/executor-types.ts'
import {
  validateSessionStateTransition,
  type DevelopmentGroupDefinition,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime,
  type DevelopmentSessionStatus
} from '../contracts/index.ts'
import { buildDevelopmentSessionPrompt } from './prompt-builder.ts'

export interface ExecutorManagerPort {
  start(executorId: string, identity: ExecutorTaskIdentity, policy: ExecutorPolicyContext): Promise<ExecutorSession>
  startFromHandoff(
    executorId: string,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession>
  resume(
    executorId: string,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    ref: ExecutorSessionRef,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession>
  prompt(identity: Pick<ExecutorTaskIdentity, 'taskId' | 'executionId'>, input: ExecutorInput): AsyncIterable<ExecutorEvent>
  respondPermission(taskId: string, executionId: string, response: ExecutorPermissionResponse): Promise<void>
  cancel(taskId: string, executionId: string): Promise<void>
  close(taskId: string, executionId: string): Promise<void>
}

export interface SessionRuntimeStorePort {
  save(runtime: DevelopmentSessionRuntime): Promise<void>
}

export interface SessionRuntimeEventSink {
  onExecutorEvent(event: ExecutorEvent, runtime: DevelopmentSessionRuntime): Promise<void> | void
}

export class DevelopmentSessionRuntimeError extends Error {}

function now(): string {
  return new Date().toISOString()
}

function cloneRuntime(runtime: DevelopmentSessionRuntime): DevelopmentSessionRuntime {
  return { ...runtime }
}

export function initialSessionRuntime(session: DevelopmentSessionDefinition, at = now()): DevelopmentSessionRuntime {
  return {
    groupId: session.groupId,
    sessionId: session.sessionId,
    executionId: session.executionId,
    status: session.dependencies.length > 0 ? 'waiting_dependencies' : 'ready',
    attempt: 0,
    writerGeneration: 1,
    lastEventSequence: 0,
    updatedAt: at
  }
}

export class DevelopmentSessionRunner {
  readonly taskIdentity: ExecutorTaskIdentity
  readonly policy: ExecutorPolicyContext
  #runtime: DevelopmentSessionRuntime

  constructor(
    readonly group: DevelopmentGroupDefinition,
    readonly session: DevelopmentSessionDefinition,
    readonly requirements: readonly DevelopmentRequirement[],
    private readonly executorManager: ExecutorManagerPort,
    private readonly store: SessionRuntimeStorePort,
    private readonly sink?: SessionRuntimeEventSink,
    runtime: DevelopmentSessionRuntime = initialSessionRuntime(session)
  ) {
    if (group.groupId !== session.groupId || runtime.groupId !== group.groupId || runtime.sessionId !== session.sessionId || runtime.executionId !== session.executionId) {
      throw new DevelopmentSessionRuntimeError('Development Session runtime identity mismatch')
    }
    this.#runtime = cloneRuntime(runtime)
    this.taskIdentity = {
      taskId: `${group.groupId}:${session.sessionId}`,
      executionId: session.executionId,
      workspace: session.worktree,
      repoIdentity: group.repository,
      branch: session.branch,
      objective: session.objective,
      constraints: [
        `baseline=${session.baselineSha}`,
        `integration_ref=${session.integrationRef}`,
        ...session.ownedPaths.map(path => `owned:${path}`),
        ...session.readOnlyPaths.map(path => `read_only:${path}`),
        ...session.forbiddenPaths.map(path => `forbidden:${path}`),
        'delivery_contract=zero3.pilot.development-delivery.v1',
        `subagent_max=${session.subagentPolicy.maxConcurrency}`,
        'recursive_group_creation=false'
      ],
      acceptanceCriteria: [...session.acceptanceCriteria]
    }
    this.policy = {
      permissionProfile: session.executorPolicy.permissionProfile,
      approvalRequired: session.executorPolicy.approvalRequired
    }
  }

  snapshot(): DevelopmentSessionRuntime {
    return cloneRuntime(this.#runtime)
  }

  promptText(): string {
    return buildDevelopmentSessionPrompt({ group: this.group, session: this.session, requirements: this.requirements })
  }

  async markReady(): Promise<void> {
    if (this.#runtime.status !== 'waiting_dependencies' && this.#runtime.status !== 'blocked') {
      throw new DevelopmentSessionRuntimeError(`cannot mark ${this.#runtime.status} session ready`)
    }
    await this.transition('ready')
    this.#runtime.blocker = undefined
    await this.persist()
  }

  async prepareRetry(): Promise<DevelopmentSessionRuntime> {
    if (this.#runtime.status === 'outcome_unknown') {
      throw new DevelopmentSessionRuntimeError('OutcomeUnknown cannot enter retry; resolve the uncertain execution first')
    }
    if (!['failed', 'blocked'].includes(this.#runtime.status)) {
      throw new DevelopmentSessionRuntimeError(`only failed/blocked sessions may retry; got ${this.#runtime.status}`)
    }
    if (this.#runtime.attempt >= this.group.policy.maxSessionAttempts) throw new DevelopmentSessionRuntimeError('session attempt budget exhausted')
    await this.transition('ready')
    this.#runtime.blocker = undefined
    await this.persist()
    return this.snapshot()
  }

  async start(): Promise<DevelopmentSessionRuntime> {
    if (this.#runtime.status !== 'ready') throw new DevelopmentSessionRuntimeError(`session must be ready before start; got ${this.#runtime.status}`)
    if (this.#runtime.attempt >= this.group.policy.maxSessionAttempts) throw new DevelopmentSessionRuntimeError('session attempt budget exhausted')
    await this.transition('starting')
    this.#runtime.attempt += 1
    await this.persist()
    try {
      const executorSession = await this.executorManager.start(this.session.executorPolicy.executorId, this.taskIdentity, this.policy)
      this.bindExecutorSession(executorSession)
      await this.transition('running')
      await this.persist()
      return this.snapshot()
    } catch (error) {
      this.#runtime.blocker = `executor_start_failed: ${String(error)}`
      await this.transition('failed')
      await this.persist()
      throw error
    }
  }

  async startFromHandoff(checkpoint: ExecutorHandoffCheckpointRef): Promise<DevelopmentSessionRuntime> {
    if (!['ready', 'blocked', 'failed'].includes(this.#runtime.status)) {
      throw new DevelopmentSessionRuntimeError(`session cannot start from handoff while ${this.#runtime.status}`)
    }
    if (this.#runtime.attempt >= this.group.policy.maxSessionAttempts) throw new DevelopmentSessionRuntimeError('session attempt budget exhausted')
    await this.transition(this.#runtime.status === 'ready' ? 'starting' : 'ready')
    if (this.#runtime.status === 'ready') await this.transition('starting')
    this.#runtime.attempt += 1
    await this.persist()
    const executorSession = await this.executorManager.startFromHandoff(this.session.executorPolicy.executorId, this.taskIdentity, this.policy, checkpoint)
    this.bindExecutorSession(executorSession)
    this.#runtime.writerGeneration = executorSession.generation
    await this.transition('running')
    this.#runtime.blocker = undefined
    await this.persist()
    return this.snapshot()
  }

  async resume(ref: ExecutorSessionRef, checkpoint: ExecutorHandoffCheckpointRef): Promise<DevelopmentSessionRuntime> {
    if (!['ready', 'blocked', 'failed', 'paused'].includes(this.#runtime.status)) {
      throw new DevelopmentSessionRuntimeError(`session cannot resume while ${this.#runtime.status}`)
    }
    if (this.#runtime.status !== 'ready') await this.transition('ready')
    await this.transition('starting')
    await this.persist()
    const executorSession = await this.executorManager.resume(this.session.executorPolicy.executorId, this.taskIdentity, this.policy, ref, checkpoint)
    this.bindExecutorSession(executorSession)
    this.#runtime.writerGeneration = executorSession.generation
    await this.transition('running')
    this.#runtime.blocker = undefined
    await this.persist()
    return this.snapshot()
  }

  async sendInitialInstruction(clientRequestId: string): Promise<DevelopmentSessionRuntime> {
    return this.sendInstruction(clientRequestId, this.promptText())
  }

  async sendInstruction(clientRequestId: string, text: string): Promise<DevelopmentSessionRuntime> {
    if (this.#runtime.status !== 'running') throw new DevelopmentSessionRuntimeError(`session must be running before prompt; got ${this.#runtime.status}`)
    const input: ExecutorInput = { clientRequestId, text }
    try {
      let executorSequence = 0
      for await (const event of this.executorManager.prompt(this.taskIdentity, input)) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= executorSequence) {
          this.#runtime.blocker = `executor_event_sequence_invalid:${event.sequence}`
          await this.transition('outcome_unknown')
          await this.persist()
          throw new DevelopmentSessionRuntimeError('Executor event sequence is not strictly monotonic within prompt attempt')
        }
        executorSequence = event.sequence
        await this.applyExecutorEvent(event)
      }
      return this.snapshot()
    } catch (error) {
      if (this.#runtime.status !== 'outcome_unknown') {
        this.#runtime.blocker = `executor_prompt_outcome_unknown: ${String(error)}`
        await this.transition('outcome_unknown')
        await this.persist()
      }
      throw error
    }
  }

  async respondPermission(response: ExecutorPermissionResponse): Promise<DevelopmentSessionRuntime> {
    if (this.#runtime.status !== 'waiting_input' || !this.#runtime.pendingPermissionRequestId) {
      throw new DevelopmentSessionRuntimeError('there is no pending Development Session permission request')
    }
    if (response.requestId !== this.#runtime.pendingPermissionRequestId) throw new DevelopmentSessionRuntimeError('permission response requestId mismatch')
    await this.executorManager.respondPermission(this.taskIdentity.taskId, this.taskIdentity.executionId, response)
    this.#runtime.pendingPermissionRequestId = undefined
    await this.transition('running')
    await this.persist()
    return this.snapshot()
  }

  async cancel(): Promise<DevelopmentSessionRuntime> {
    if (['verified', 'cancelled', 'superseded'].includes(this.#runtime.status)) return this.snapshot()
    await this.executorManager.cancel(this.taskIdentity.taskId, this.taskIdentity.executionId)
    await this.transition('cancelled')
    this.#runtime.blocker = undefined
    this.#runtime.pendingPermissionRequestId = undefined
    await this.persist()
    return this.snapshot()
  }

  async close(): Promise<void> {
    await this.executorManager.close(this.taskIdentity.taskId, this.taskIdentity.executionId)
  }

  async markOutcomeUnknown(reason: string): Promise<DevelopmentSessionRuntime> {
    if (!['starting', 'running', 'waiting_input', 'delivering'].includes(this.#runtime.status)) {
      throw new DevelopmentSessionRuntimeError(`cannot mark ${this.#runtime.status} as OutcomeUnknown`)
    }
    this.#runtime.blocker = reason
    this.#runtime.pendingPermissionRequestId = undefined
    await this.transition('outcome_unknown')
    await this.persist()
    return this.snapshot()
  }

  private bindExecutorSession(executorSession: ExecutorSession): void {
    this.#runtime.executorId = executorSession.executorId
    this.#runtime.executorSessionId = executorSession.sessionId
    this.#runtime.writerGeneration = executorSession.generation
  }

  private async applyExecutorEvent(event: ExecutorEvent): Promise<void> {
    this.#runtime.lastEventSequence += 1
    this.#runtime.updatedAt = event.at
    if (event.type === 'permission.requested') {
      this.#runtime.pendingPermissionRequestId = event.requestId
      if (this.#runtime.status === 'running') await this.transition('waiting_input')
    } else if (event.type === 'permission.resolved') {
      if (this.#runtime.pendingPermissionRequestId === event.requestId) this.#runtime.pendingPermissionRequestId = undefined
      if (this.#runtime.status === 'waiting_input') await this.transition('running')
    } else if (event.type === 'completed') {
      if (this.#runtime.status === 'waiting_input') throw new DevelopmentSessionRuntimeError('Executor completed while permission request is unresolved')
      if (this.#runtime.status === 'running') await this.transition('delivering')
    } else if (event.type === 'cancelled') {
      if (!['cancelled', 'verified', 'superseded'].includes(this.#runtime.status)) await this.transition('cancelled')
    } else if (event.type === 'failure') {
      this.#runtime.blocker = `${event.failure.code}: ${event.failure.message}`
      if (event.failure.code === 'user_stopped') await this.transition('cancelled')
      else if (event.failure.code === 'context_lost' || event.failure.code === 'context_exhausted') await this.transition('blocked')
      else if (event.failure.code === 'transport_lost' || event.failure.code === 'process_crash') await this.transition('outcome_unknown')
      else await this.transition('failed')
    }
    await this.persist()
    await this.sink?.onExecutorEvent(event, this.snapshot())
  }

  private async transition(next: DevelopmentSessionStatus): Promise<void> {
    const issues = validateSessionStateTransition(this.#runtime.status, next)
    if (issues.length > 0) throw new DevelopmentSessionRuntimeError(issues[0].message)
    this.#runtime.status = next
    this.#runtime.updatedAt = now()
  }

  private async persist(): Promise<void> {
    await this.store.save(this.snapshot())
  }
}
