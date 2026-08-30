import { isExecutorFailure } from './failure-normalizer.ts'
import type {
  ExecutorEvent,
  ExecutorHandoffCheckpointRef,
  ExecutorId,
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorPolicyContext,
  ExecutorSession,
  ExecutorSessionRef,
  ExecutorStartContext,
  ExecutorTaskIdentity
} from './executor-types.ts'
import { ZERO3_EXECUTOR_CONTRACT, ZERO3_HANDOFF_PROTOCOL } from './executor-types.ts'
import type { Zero3ExecutorRegistry } from './executor-registry.ts'

export class ExecutorManagerError extends Error {}

export interface ExecutorBindingSnapshot {
  identity: ExecutorTaskIdentity
  policy: ExecutorPolicyContext
  executorId: ExecutorId
  session: ExecutorSessionRef
}

interface ExecutorBinding extends ExecutorBindingSnapshot {
  session: ExecutorSession
  pendingPermissions: Map<string, boolean>
}

export class Zero3ExecutorManager {
  readonly #bindings = new Map<string, ExecutorBinding>()

  constructor(private readonly registry: Zero3ExecutorRegistry) {}

  async start(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext
  ): Promise<ExecutorSession> {
    return this.startWithContext(executorId, identity, policy, 1)
  }

  async startFromHandoff(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession> {
    this.assertHandoffCheckpoint(checkpoint)
    const generation = checkpoint.generation + 1
    this.assertGeneration(generation)
    return this.startWithContext(executorId, identity, policy, generation, checkpoint)
  }

  async resume(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    ref: ExecutorSessionRef,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession> {
    this.assertIdentity(identity)
    this.assertGeneration(ref.generation)
    this.assertHandoffCheckpoint(checkpoint)
    if (checkpoint.generation !== ref.generation) {
      throw new ExecutorManagerError('handoff checkpoint generation must match the session generation')
    }
    if (ref.executorId !== executorId) {
      throw new ExecutorManagerError('session reference executor does not match the selected executor')
    }

    const key = this.bindingKey(identity.taskId, identity.executionId)
    if (this.#bindings.has(key)) {
      throw new ExecutorManagerError(`task execution already has an active executor session: ${key}`)
    }

    const executor = this.registry.require(executorId)
    const session = await executor.resume(ref, checkpoint)
    this.assertReturnedSession(executorId, ref.generation, session)
    this.#bindings.set(key, {
      identity: this.snapshotIdentity(identity),
      policy: { ...policy },
      executorId,
      session,
      pendingPermissions: new Map()
    })
    return session
  }

  async *prompt(
    identity: Pick<ExecutorTaskIdentity, 'taskId' | 'executionId'>,
    input: ExecutorInput
  ): AsyncIterable<ExecutorEvent> {
    const binding = this.requireBinding(identity.taskId, identity.executionId)
    const executor = this.registry.require(binding.executorId)
    let lastSequence = 0
    for await (const event of executor.prompt(binding.session, input)) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
        throw new ExecutorManagerError('executor event sequence must be a strictly increasing positive safe integer')
      }
      lastSequence = event.sequence

      if (event.type === 'permission.requested') {
        this.assertPermissionRequestId(event.requestId)
        if (binding.pendingPermissions.has(event.requestId)) {
          throw new ExecutorManagerError(`duplicate pending permission request: ${event.requestId}`)
        }
        binding.pendingPermissions.set(event.requestId, event.allowSessionApproval === true)
      }
      if (event.type === 'failure' && !isExecutorFailure(event.failure)) {
        throw new ExecutorManagerError('executor emitted a failure outside the frozen Zero3 taxonomy')
      }
      if (event.type === 'completed') binding.pendingPermissions.clear()
      yield event
    }
  }

  async respondPermission(
    taskId: string,
    executionId: string,
    response: ExecutorPermissionResponse
  ): Promise<void> {
    this.assertPermissionResponse(response)
    const binding = this.requireBinding(taskId, executionId)
    const allowSessionApproval = binding.pendingPermissions.get(response.requestId)
    if (allowSessionApproval === undefined) {
      throw new ExecutorManagerError(`permission request is not pending for this task execution: ${response.requestId}`)
    }
    if (response.decision === 'approve_session' && !allowSessionApproval) {
      throw new ExecutorManagerError('executor permission request does not allow session-wide approval')
    }
    const executor = this.registry.require(binding.executorId)
    await executor.respondPermission(binding.session, response)
    binding.pendingPermissions.delete(response.requestId)
  }

  async cancel(taskId: string, executionId: string): Promise<void> {
    const binding = this.requireBinding(taskId, executionId)
    const executor = this.registry.require(binding.executorId)
    await executor.cancel(binding.session)
  }

  async close(taskId: string, executionId: string): Promise<void> {
    const key = this.bindingKey(taskId, executionId)
    const binding = this.requireBinding(taskId, executionId)
    const executor = this.registry.require(binding.executorId)
    try {
      await executor.close(binding.session)
    } finally {
      this.#bindings.delete(key)
    }
  }

  active(taskId: string, executionId: string): ExecutorBindingSnapshot | undefined {
    const binding = this.#bindings.get(this.bindingKey(taskId, executionId))
    if (!binding) return undefined
    return {
      identity: this.snapshotIdentity(binding.identity),
      policy: { ...binding.policy },
      executorId: binding.executorId,
      session: {
        executorId: binding.session.executorId,
        sessionId: binding.session.sessionId,
        generation: binding.session.generation
      }
    }
  }

  private async startWithContext(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    generation: number,
    handoff?: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession> {
    this.assertIdentity(identity)
    this.assertGeneration(generation)
    if (handoff) this.assertHandoffCheckpoint(handoff)
    const key = this.bindingKey(identity.taskId, identity.executionId)
    if (this.#bindings.has(key)) {
      throw new ExecutorManagerError(`task execution already has an active executor session: ${key}`)
    }

    const executor = this.registry.require(executorId)
    const identitySnapshot = this.snapshotIdentity(identity)
    const policySnapshot = { ...policy }
    const context: ExecutorStartContext = {
      contract: ZERO3_EXECUTOR_CONTRACT,
      identity: identitySnapshot,
      policy: policySnapshot,
      generation,
      ...(handoff ? { handoff: { ...handoff } } : {})
    }
    const session = await executor.start(context)
    this.assertReturnedSession(executorId, generation, session)
    this.#bindings.set(key, {
      identity: identitySnapshot,
      policy: policySnapshot,
      executorId,
      session,
      pendingPermissions: new Map()
    })
    return session
  }

  private requireBinding(taskId: string, executionId: string): ExecutorBinding {
    const key = this.bindingKey(taskId, executionId)
    const binding = this.#bindings.get(key)
    if (!binding) throw new ExecutorManagerError(`no active executor session for task execution: ${key}`)
    return binding
  }

  private bindingKey(taskId: string, executionId: string): string {
    return `${taskId}\u0000${executionId}`
  }

  private snapshotIdentity(identity: ExecutorTaskIdentity): ExecutorTaskIdentity {
    return {
      ...identity,
      constraints: [...identity.constraints],
      acceptanceCriteria: [...identity.acceptanceCriteria],
      control: identity.control ? { ...identity.control } : undefined
    }
  }

  private assertIdentity(identity: ExecutorTaskIdentity): void {
    for (const [name, value] of [
      ['taskId', identity.taskId],
      ['executionId', identity.executionId],
      ['workspace', identity.workspace],
      ['objective', identity.objective]
    ] as const) {
      if (!value.trim()) throw new ExecutorManagerError(`${name} must be non-empty`)
    }
    if (
      identity.control &&
      (!identity.control.leaseId.trim() ||
        !Number.isSafeInteger(identity.control.fencingToken) ||
        identity.control.fencingToken < 1)
    ) {
      throw new ExecutorManagerError('control identity requires a non-empty lease id and positive fencing token')
    }
  }

  private assertGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new ExecutorManagerError('executor generation must be a positive safe integer')
    }
  }

  private assertHandoffCheckpoint(checkpoint: ExecutorHandoffCheckpointRef): void {
    if (checkpoint.protocol !== ZERO3_HANDOFF_PROTOCOL) {
      throw new ExecutorManagerError('handoff checkpoint protocol is unsupported')
    }
    this.assertGeneration(checkpoint.generation)
    if (!checkpoint.checkpointHash.trim() || !checkpoint.workspaceFingerprint.trim()) {
      throw new ExecutorManagerError('handoff checkpoint requires hash and workspace fingerprint')
    }
  }

  private assertPermissionRequestId(requestId: string): void {
    if (!requestId.trim()) throw new ExecutorManagerError('permission request id must be non-empty')
  }

  private assertPermissionResponse(response: ExecutorPermissionResponse): void {
    this.assertPermissionRequestId(response.requestId)
    if (!['approve_once', 'approve_session', 'deny'].includes(response.decision)) {
      throw new ExecutorManagerError('permission decision is unsupported')
    }
  }

  private assertReturnedSession(executorId: ExecutorId, generation: number, session: ExecutorSession): void {
    if (session.executorId !== executorId) {
      throw new ExecutorManagerError('executor returned a session for a different executor id')
    }
    if (session.generation !== generation) {
      throw new ExecutorManagerError('executor returned a session with a different generation')
    }
    if (!session.sessionId.trim()) throw new ExecutorManagerError('executor returned an empty session id')
  }
}
