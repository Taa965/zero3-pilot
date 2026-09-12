import { randomUUID } from 'node:crypto'

import type {
  Zero3CapabilityDefinition,
  Zero3InvokeCapabilityRequest,
  Zero3OperationRecord
} from './contracts.ts'
import { Zero3OperationStore, zero3CapabilityInputFingerprint } from './operation-store.ts'
import type { Zero3CapabilityPolicyPort } from './policy-port.ts'
import { Zero3CapabilityRegistry } from './registry.ts'
import { Zero3CapabilityTimeoutError } from './powershell-capability.ts'

function idempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(key)) throw new Error('idempotencyKey is required and must be a safe 1..256 character id')
  return key
}

function operationId(): string {
  return `op-${randomUUID()}`
}

export class Zero3OperationRuntime {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly registry: Zero3CapabilityRegistry,
    private readonly store: Zero3OperationStore,
    private readonly policy: Zero3CapabilityPolicyPort,
    private readonly nodeId: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  listCapabilities(input: Record<string, unknown> = {}): { protocol: string; capabilities: Zero3CapabilityDefinition[] } {
    const category = typeof input.category === 'string' ? input.category.trim() : ''
    const capabilities = this.registry.list().filter(capability => !category || capability.category === category)
    return { protocol: 'zero3.remote-capability.v1', capabilities }
  }

  describeCapability(input: Record<string, unknown>): Zero3CapabilityDefinition {
    const capability = typeof input.capability === 'string' ? input.capability.trim() : ''
    const definition = capability ? this.registry.describe(capability) : null
    if (!definition) throw new Error(`Zero3 capability not found: ${capability || '<empty>'}`)
    return definition
  }

  async invokeCapability(request: Zero3InvokeCapabilityRequest): Promise<Zero3OperationRecord> {
    const capability = typeof request.capability === 'string' ? request.capability.trim() : ''
    const definition = capability ? this.registry.describe(capability) : null
    const handler = capability ? this.registry.handler(capability) : null
    if (!definition || !handler) throw new Error(`Zero3 capability not found: ${capability || '<empty>'}`)
    if (definition.status !== 'available') throw new Error(`Zero3 capability is ${definition.status}: ${capability}`)
    const key = idempotencyKey(request.idempotencyKey)
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input : {}
    const inputFingerprint = zero3CapabilityInputFingerprint({ input, context: request.context ?? null })
    const replay = this.store.findByIdempotency(capability, key)
    if (replay) {
      if (replay.inputFingerprint !== inputFingerprint) throw new Error('idempotencyKey was reused with different capability input')
      return replay
    }

    const decision = await this.policy.authorize({ definition, input, context: request.context })
    const createdAt = this.now()
    const base: Zero3OperationRecord = {
      protocol: 'zero3.remote-capability.v1',
      operationId: operationId(),
      capability,
      nodeId: this.nodeId,
      status: decision.decision === 'allow' ? 'QUEUED' : decision.decision === 'require_confirmation' ? 'WAITING_APPROVAL' : 'BLOCKED',
      input: structuredClone(input),
      ...(request.context ? { context: structuredClone(request.context) } : {}),
      idempotencyKey: key,
      inputFingerprint,
      createdAt,
      startedAt: null,
      completedAt: decision.decision === 'deny' ? createdAt : null,
      progress: decision.decision === 'deny' ? 1 : 0,
      result: null,
      error: decision.decision === 'deny' ? { code: 'POLICY_DENIED', message: decision.reason } : null
    }
    const created = this.store.create(base)
    if (decision.decision !== 'allow') return created

    const controller = new AbortController()
    this.active.set(created.operationId, controller)
    this.store.update(created.operationId, { status: 'RUNNING', startedAt: this.now(), progress: 0 })
    void (async () => {
      try {
        const result = await handler({
          operationId: created.operationId,
          definition,
          input,
          context: request.context,
          signal: controller.signal
        })
        const current = this.store.get(created.operationId)
        if (!current || current.status === 'CANCELLED') return
        this.store.update(created.operationId, {
          status: 'COMPLETED', completedAt: this.now(), progress: 1, result: structuredClone(result), error: null
        })
      } catch (error) {
        const current = this.store.get(created.operationId)
        if (!current || current.status === 'CANCELLED') return
        const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        const timedOut = error instanceof Zero3CapabilityTimeoutError
        this.store.update(created.operationId, {
          status: aborted ? 'CANCELLED' : timedOut ? 'TIMED_OUT' : 'FAILED',
          completedAt: this.now(),
          progress: 1,
          error: {
            code: aborted ? 'CANCELLED' : timedOut ? 'TIMEOUT' : 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      } finally {
        this.active.delete(created.operationId)
      }
    })()
    return this.store.get(created.operationId)!
  }

  getOperation(input: Record<string, unknown>): Zero3OperationRecord {
    const id = typeof input.operationId === 'string' ? input.operationId.trim() : ''
    const operation = id ? this.store.get(id) : null
    if (!operation) throw new Error(`Zero3 operation not found: ${id || '<empty>'}`)
    return operation
  }

  cancelOperation(input: Record<string, unknown>): Zero3OperationRecord {
    const operation = this.getOperation(input)
    if (['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(operation.status)) return operation
    this.active.get(operation.operationId)?.abort()
    return this.store.update(operation.operationId, {
      status: 'CANCELLED', completedAt: this.now(), progress: 1,
      error: { code: 'CANCELLED', message: 'Operation cancelled by Zero3 remote caller.' }
    })
  }

  close(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }
}
