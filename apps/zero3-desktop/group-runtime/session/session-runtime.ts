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
    if (this.#runtime.status !== 'running' && this.#runtime.status !== 'waiting_input') {
      throw new DevelopmentSessionRuntimeError(`session cannot prompt while ${this.#runtime.status}`)
    }
    if (!clientRequestId.trim() || !text.trim()) throw new DevelopmentSessionRuntimeError('instruction request id and text must be non-empty')
    const input: ExecutorInput = { kind: 'prompt', clientRequestId: clientRequestId.trim(), text }
    try {
      for await (const event of this.executorManager.prompt(this.taskIdentity, input)) {
        await this.applyExecutorEvent(event)
        await this.sink?.onExecutorEvent(event, this.snapshot())
      }
      return this.snapshot()
    } catch (error) {
      // A transport/process exception during an active prompt may occur after a side effect.
      // Without an authoritative terminal event the control plane cannot safely infer failure/retry.
      await this.markOutcomeUnknown(`executor_prompt_exception: ${String(error)}`)
      throw error
    }
  }

  async respondPermission(response: ExecutorPermissionResponse): Promise<void> {
    if (this.#runtime.status !== 'waiting_input') throw new DevelopmentSessionRuntimeError('no permission/input wait is active')
    await this.executorManager.respondPermission(this.taskIdentity.taskId, this.taskIdentity.executionId, response)
    await this.transition('running')
    await this.persist()
  }

  async cancel(): Promise<void> {
    if (['verified', 'cancelled', 'superseded'].includes(this.#runtime.status)) return
    await this.executorManager.cancel(this.taskIdentity.taskId, this.taskIdentity.executionId)
    await this.transition('cancelled')
    await this.persist()
  }

  async close(): Promise<void> {
    await this.executorManager.close(this.taskIdentity.taskId, this.taskIdentity.executionId)
  }

  async markOutcomeUnknown(reason: string): Promise<void> {
    if (!reason.trim()) throw new DevelopmentSessionRuntimeError('OutcomeUnknown reason is required')
    if (this.#runtime.status === 'outcome_unknown') return
    await this.transition('outcome_unknown')
    this.#runtime.blocker = reason.trim()
    await this.persist()
  }

  private async applyExecutorEvent(event: ExecutorEvent): Promise<void> {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      throw new DevelopmentSessionRuntimeError('executor event sequence must be a positive safe integer')
    }
    // ExecutorManager verifies monotonic ordering within each prompt stream. A Development
    // Session has its own durable lifetime sequence because executor stream numbers may restart
    // from 1 for a later prompt/resume.
    this.#runtime.lastEventSequence += 1

    if (['blocked', 'failed', 'outcome_unknown', 'cancelled'].includes(this.#runtime.status)) {
      await this.persist()
      return
    }
    if (this.#runtime.status === 'waiting_input' && event.type !== 'permission.requested') {
      await this.transition('running')
    }

    if (event.type === 'permission.requested') {
      await this.transition('waiting_input')
    } else if (event.type === 'failure') {
      if (event.failure.code === 'context_lost' || event.failure.code === 'context_exhausted') {
        await this.transition('blocked')
        this.#runtime.blocker = event.failure.code
      } else if (event.failure.code === 'transport_lost' || event.failure.code === 'process_crash') {
        await this.transition('outcome_unknown')
        this.#runtime.blocker = event.failure.code
      } else if (event.failure.code === 'permission_denied' || event.failure.code === 'policy_denied') {
        await this.transition('blocked')
        this.#runtime.blocker = event.failure.code
      } else {
        await this.transition('failed')
        this.#runtime.blocker = event.failure.code
      }
    } else if (event.type === 'completed') {
      if (event.outcome === 'succeeded') await this.transition('delivering')
      else if (event.outcome === 'cancelled') await this.transition('cancelled')
      else await this.transition('failed')
    }
    await this.persist()
  }

  private bindExecutorSession(session: ExecutorSession): void {
    this.#runtime.executorId = session.executorId
    this.#runtime.executorSessionId = session.sessionId
    this.#runtime.executorGeneration = session.generation
    this.#runtime.writerGeneration = session.generation
  }

  private async transition(next: DevelopmentSessionStatus): Promise<void> {
    const issues = validateSessionStateTransition(this.#runtime.status, next)
    if (issues.length > 0) throw new DevelopmentSessionRuntimeError(issues[0].message)
    this.#runtime.status = next
    this.#runtime.updatedAt = now()
  }

  private persist(): Promise<void> {
    return this.store.save(this.snapshot())
  }
}
