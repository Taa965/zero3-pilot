import path from 'node:path'

import { Zero3ExecutorManager } from '../executor-manager.ts'
import {
  ZERO3_HANDOFF_PROTOCOL,
  type ExecutorEvent,
  type ExecutorFailure,
  type ExecutorHandoffCheckpointRef,
  type ExecutorId,
  type ExecutorInput,
  type ExecutorPermissionResponse,
  type ExecutorPolicyContext,
  type ExecutorSession,
  type ExecutorSessionRef,
  type ExecutorTaskIdentity
} from '../executor-types.ts'
import { buildHandoffCheckpoint, captureWorkspaceState } from '../handoff/handoff-builder.ts'
import { HandoffStore } from '../handoff/handoff-store.ts'
import { HANDOFF_VERIFY_INSTRUCTION, verifyHandoff } from '../handoff/handoff-verifier.ts'
import { WorkspaceWriterGate, type WorkspaceWriterLease } from '../handoff/workspace-lease.ts'
import { Zero3FailoverController, type FailoverAction, type FailoverConfig } from './failover-controller.ts'

export interface Zero3AutomaticFailoverRuntimeOptions {
  config: FailoverConfig
  handoffRoot: string
  nowMs?: () => number
  nowIso?: () => string
}

type Binding = {
  identity: ExecutorTaskIdentity
  policy: ExecutorPolicyContext
  controller: Zero3FailoverController
  gate: WorkspaceWriterGate
  lease: WorkspaceWriterLease
  handoffStore: HandoffStore
}

function key(taskId: string, executionId: string): string {
  return `${taskId}\u0000${executionId}`
}

function baseSha(identity: ExecutorTaskIdentity, fallback: string): string {
  const marker = identity.constraints.find(value => value.startsWith('baseline='))?.slice('baseline='.length).trim()
  return marker || fallback
}

function nextCandidate(config: FailoverConfig, current: ExecutorId): ExecutorId | undefined {
  const index = config.candidates.indexOf(current)
  if (index < 0) return undefined
  for (let offset = 1; offset < config.candidates.length; offset += 1) {
    const candidate = config.candidates[(index + offset) % config.candidates.length]
    if (candidate !== current) return candidate
  }
  return undefined
}

function resequence(event: ExecutorEvent, sequence: number): ExecutorEvent {
  return { ...event, sequence } as ExecutorEvent
}

export class Zero3FailoverExecutorManager {
  readonly #bindings = new Map<string, Binding>()
  readonly #nowMs: () => number
  readonly #nowIso: () => string

  constructor(
    private readonly manager: Zero3ExecutorManager,
    readonly options: Zero3AutomaticFailoverRuntimeOptions
  ) {
    if (!path.isAbsolute(options.handoffRoot)) throw new Error('failover handoffRoot must be absolute')
    this.#nowMs = options.nowMs ?? (() => Date.now())
    this.#nowIso = options.nowIso ?? (() => new Date().toISOString())
  }

  async start(executorId: ExecutorId, identity: ExecutorTaskIdentity, policy: ExecutorPolicyContext): Promise<ExecutorSession> {
    const session = await this.manager.start(executorId, identity, policy)
    try {
      await this.bind(executorId, identity, policy, session)
      return session
    } catch (error) {
      try { await this.manager.close(identity.taskId, identity.executionId) } catch {}
      throw error
    }
  }

  async startFromHandoff(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession> {
    const session = await this.manager.startFromHandoff(executorId, identity, policy, checkpoint)
    try {
      await this.bind(executorId, identity, policy, session)
      return session
    } catch (error) {
      try { await this.manager.close(identity.taskId, identity.executionId) } catch {}
      throw error
    }
  }

  async resume(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    ref: ExecutorSessionRef,
    checkpoint: ExecutorHandoffCheckpointRef
  ): Promise<ExecutorSession> {
    const session = await this.manager.resume(executorId, identity, policy, ref, checkpoint)
    try {
      await this.bind(executorId, identity, policy, session)
      return session
    } catch (error) {
      try { await this.manager.close(identity.taskId, identity.executionId) } catch {}
      throw error
    }
  }

  async *prompt(
    identity: Pick<ExecutorTaskIdentity, 'taskId' | 'executionId'>,
    input: ExecutorInput
  ): AsyncIterable<ExecutorEvent> {
    const binding = this.requireBinding(identity.taskId, identity.executionId)
    let currentInput = input
    let outwardSequence = 0
    let failureOrdinal = 0

    while (true) {
      let continueAfterPolicyAction = false
      for await (const event of this.manager.prompt(identity, currentInput)) {
        if (event.type === 'failure') {
          failureOrdinal += 1
          const eventId = `${identity.taskId}:${identity.executionId}:failure:${failureOrdinal}:${event.failure.code}`
          const action = binding.controller.onFailure(eventId, event.failure, this.#nowMs())

          if (action.type === 'retry') {
            continueAfterPolicyAction = true
            currentInput = this.retryInput(input, action, event.failure)
            outwardSequence += 1
            yield {
              type: 'message',
              sequence: outwardSequence,
              at: this.#nowIso(),
              text: `[Zero3 failover] ${event.failure.code}: retry ${action.attempt}/${action.maxAttempts} on ${action.executorId}.`
            }
            break
          }

          if (action.type === 'switch') {
            const checkpoint = await this.verifiedSwitch(binding, eventId, action, event.failure, input)
            continueAfterPolicyAction = true
            currentInput = this.handoffInput(input, checkpoint)
            outwardSequence += 1
            yield {
              type: 'message',
              sequence: outwardSequence,
              at: this.#nowIso(),
              text: `[Zero3 failover] ${action.fromExecutorId} → ${action.toExecutorId}; verified handoff generation ${action.targetGeneration}.`
            }
            break
          }

          if (action.type === 'handoff' && this.options.config.automaticFailover) {
            const target = nextCandidate(this.options.config, action.fromExecutorId)
            if (!target) {
              outwardSequence += 1
              yield resequence(event, outwardSequence)
              continue
            }
            const switchEventId = `${eventId}:handoff-switch`
            const planned = binding.controller.manualSwitch(switchEventId, target)
            if (planned.type !== 'switch') {
              outwardSequence += 1
              yield resequence(event, outwardSequence)
              continue
            }
            const checkpoint = await this.verifiedSwitch(binding, switchEventId, planned, event.failure, input)
            continueAfterPolicyAction = true
            currentInput = this.handoffInput(input, checkpoint)
            outwardSequence += 1
            yield {
              type: 'message',
              sequence: outwardSequence,
              at: this.#nowIso(),
              text: `[Zero3 failover] ${event.failure.code} required handoff; ${planned.fromExecutorId} → ${planned.toExecutorId} generation ${planned.targetGeneration}.`
            }
            break
          }

          outwardSequence += 1
          yield resequence(event, outwardSequence)
          continue
        }

        if (event.type === 'completed' && event.outcome === 'succeeded') {
          binding.controller.recordSuccess(binding.controller.current().executorId)
        }
        outwardSequence += 1
        yield resequence(event, outwardSequence)
        if (event.type === 'completed') return
      }

      if (!continueAfterPolicyAction) return
    }
  }

  async respondPermission(taskId: string, executionId: string, response: ExecutorPermissionResponse): Promise<void> {
    return this.manager.respondPermission(taskId, executionId, response)
  }

  async cancel(taskId: string, executionId: string): Promise<void> {
    return this.manager.cancel(taskId, executionId)
  }

  async close(taskId: string, executionId: string): Promise<void> {
    const binding = this.#bindings.get(key(taskId, executionId))
    try {
      await this.manager.close(taskId, executionId)
    } finally {
      if (binding) {
        const current = await binding.gate.current()
        if (current && current.task_id === taskId && current.execution_id === executionId) {
          await binding.gate.release(current)
        }
      }
      this.#bindings.delete(key(taskId, executionId))
    }
  }

  active(taskId: string, executionId: string) {
    return this.manager.active(taskId, executionId)
  }

  private async bind(
    executorId: ExecutorId,
    identity: ExecutorTaskIdentity,
    policy: ExecutorPolicyContext,
    session: ExecutorSession
  ): Promise<void> {
    if (!this.options.config.candidates.includes(executorId)) return
    const gate = new WorkspaceWriterGate(identity.workspace)
    let lease = await gate.current()
    if (lease) {
      if (
        lease.task_id !== identity.taskId ||
        lease.execution_id !== identity.executionId ||
        lease.executor_id !== executorId ||
        lease.generation !== session.generation ||
        lease.state !== 'active'
      ) {
        throw new Error('existing workspace writer lease does not match resumed failover authority')
      }
    } else {
      lease = await gate.acquire(identity.taskId, identity.executionId, identity.workspace, executorId, session.generation)
    }
    this.#bindings.set(key(identity.taskId, identity.executionId), {
      identity: {
        ...identity,
        constraints: [...identity.constraints],
        acceptanceCriteria: [...identity.acceptanceCriteria],
        control: identity.control ? { ...identity.control } : undefined
      },
      policy: { ...policy },
      controller: new Zero3FailoverController(this.options.config, executorId, session.generation),
      gate,
      lease,
      handoffStore: new HandoffStore(this.options.handoffRoot)
    })
  }

  private requireBinding(taskId: string, executionId: string): Binding {
    const binding = this.#bindings.get(key(taskId, executionId))
    if (!binding) throw new Error(`automatic failover binding is unavailable for ${taskId}/${executionId}`)
    return binding
  }

  private async verifiedSwitch(
    binding: Binding,
    eventId: string,
    action: Extract<FailoverAction, { type: 'switch' }>,
    failure: ExecutorFailure,
    input: ExecutorInput
  ) {
    const active = this.manager.active(binding.identity.taskId, binding.identity.executionId)
    if (!active) throw new Error('cannot handoff without an active executor binding')
    if (active.executorId !== action.fromExecutorId || active.session.generation !== binding.lease.generation) {
      throw new Error('active executor authority changed before handoff')
    }

    const pending = await binding.gate.beginHandoff(binding.lease)
    const observedBefore = await captureWorkspaceState(binding.identity.workspace)
    const checkpoint = await buildHandoffCheckpoint({
      taskId: binding.identity.taskId,
      executionId: binding.identity.executionId,
      workspace: binding.identity.workspace,
      repoId: binding.identity.repoIdentity?.trim() || binding.identity.workspace,
      baseSha: baseSha(binding.identity, observedBefore.headSha),
      objective: binding.identity.objective,
      constraints: [...binding.identity.constraints],
      acceptanceCriteria: [...binding.identity.acceptanceCriteria],
      completed: [],
      inProgress: [input.text],
      remaining: [input.text],
      testsRun: [],
      testResults: [],
      pendingApprovals: [],
      lastExecutor: action.fromExecutorId,
      lastSessionId: active.session.sessionId,
      stopReason: failure.code,
      nextAction: `Continue the interrupted Zero3 instruction after verified handoff: ${input.text}`,
      previousGeneration: active.session.generation,
      createdAt: this.#nowIso()
    })
    await binding.handoffStore.save(checkpoint)
    const observed = await captureWorkspaceState(binding.identity.workspace)
    const verification = verifyHandoff(checkpoint, {
      workspace: observed.workspace,
      branch: observed.branch,
      headSha: observed.headSha,
      dirtyWorktreeFingerprint: observed.dirtyWorktreeFingerprint
    })
    if (verification.decision !== 'HANDOFF_ACCEPT') {
      binding.controller.abortSwitch(eventId)
      throw new Error(`handoff verification rejected: ${verification.reasons.join('; ')}`)
    }

    const checkpointRef: ExecutorHandoffCheckpointRef = {
      protocol: ZERO3_HANDOFF_PROTOCOL,
      checkpointHash: checkpoint.checkpoint_hash,
      generation: active.session.generation,
      workspaceFingerprint: checkpoint.dirty_worktree_fingerprint
    }

    await this.manager.close(binding.identity.taskId, binding.identity.executionId)
    const nextSession = await this.manager.startFromHandoff(
      action.toExecutorId,
      binding.identity,
      binding.policy,
      checkpointRef
    )
    if (nextSession.generation !== action.targetGeneration) {
      binding.controller.abortSwitch(eventId)
      throw new Error('new executor generation does not match planned failover generation')
    }
    binding.lease = await binding.gate.acceptHandoff(pending, action.toExecutorId, verification)
    binding.controller.commitVerifiedSwitch(eventId, verification.generation)
    return checkpoint
  }

  private retryInput(input: ExecutorInput, action: Extract<FailoverAction, { type: 'retry' }>, failure: ExecutorFailure): ExecutorInput {
    return {
      ...input,
      clientRequestId: `${input.clientRequestId}:retry-${action.attempt}`,
      text: `Zero3 provider retry after ${failure.code}. Inspect current workspace state before repeating any side effect.\n\n${input.text}`
    }
  }

  private handoffInput(input: ExecutorInput, checkpoint: Awaited<ReturnType<typeof buildHandoffCheckpoint>>): ExecutorInput {
    return {
      ...input,
      clientRequestId: `${input.clientRequestId}:handoff-${checkpoint.handoff_generation}`,
      text: `${HANDOFF_VERIFY_INSTRUCTION}\n\nThe checkpoint below has already passed Zero3 local hash/workspace verification. Re-verify it before modifying code, then continue only from the remaining work.\n\n${JSON.stringify(checkpoint)}\n\nORIGINAL_ZERO3_INSTRUCTION:\n${input.text}`
    }
  }
}
