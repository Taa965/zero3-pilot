import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Zero3CapabilityDefinition } from './contracts.ts'
import { Zero3OperationRuntime } from './operation-runtime.ts'
import { Zero3OperationStore } from './operation-store.ts'
import { EnvironmentZero3CapabilityPolicy, type Zero3CapabilityPolicyPort } from './policy-port.ts'
import { powerShellDefinition } from './powershell-capability.ts'
import { Zero3CapabilityRegistry } from './registry.ts'

function definition(id = 'test.echo'): Zero3CapabilityDefinition {
  return {
    protocol: 'zero3.remote-capability.v1', id, version: '1.0', name: id, description: 'test', category: 'test',
    status: 'available', executionMode: 'local', supportsStreaming: false, supportsCancellation: true,
    requiresApproval: 'policy', provider: 'zero3-local', nodeId: 'node-test',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }
  }
}

const allow: Zero3CapabilityPolicyPort = {
  async authorize() { return { decision: 'allow', reason: 'test' } },
  summary() { return { mode: 'test', allowedRootCount: 1 } }
}

async function waitFor(runtime: Zero3OperationRuntime, operationId: string, status: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const current = runtime.getOperation({ operationId })
    if (current.status === status) return current
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`operation ${operationId} did not reach ${status}`)
}

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-capability-')) }

test('registry is deterministic and rejects duplicate capability ids', () => {
  const registry = new Zero3CapabilityRegistry()
  registry.register(definition('test.z'), async () => ({}))
  registry.register(definition('test.a'), async () => ({}))
  assert.deepEqual(registry.list().map(item => item.id), ['test.a', 'test.z'])
  assert.throws(() => registry.register(definition('test.a'), async () => ({})), /already registered/)
})

test('operation runtime executes locally and replays an idempotent invocation', async () => {
  const root = tempRoot()
  const registry = new Zero3CapabilityRegistry()
  registry.register(definition(), async ({ input }) => ({ echoed: input.value }))
  const runtime = new Zero3OperationRuntime(registry, new Zero3OperationStore(root), allow, 'node-test')
  const request = { capability: 'test.echo', input: { value: 42 }, idempotencyKey: 'idem-1' }
  const first = await runtime.invokeCapability(request)
  const completed = await waitFor(runtime, first.operationId, 'COMPLETED')
  assert.deepEqual(completed.result, { echoed: 42 })
  const replay = await runtime.invokeCapability(request)
  assert.equal(replay.operationId, first.operationId)
  await assert.rejects(
    runtime.invokeCapability({ capability: 'test.echo', input: { value: 43 }, idempotencyKey: 'idem-1' }),
    /different capability input/
  )
})

test('local policy denial is persisted as BLOCKED instead of executing the handler', async () => {
  const root = tempRoot()
  const registry = new Zero3CapabilityRegistry()
  let calls = 0
  registry.register(definition(), async () => { calls += 1; return {} })
  const deny: Zero3CapabilityPolicyPort = {
    async authorize() { return { decision: 'deny', reason: 'not allowed here' } },
    summary() { return { mode: 'deny', allowedRootCount: 0 } }
  }
  const runtime = new Zero3OperationRuntime(registry, new Zero3OperationStore(root), deny, 'node-test')
  const operation = await runtime.invokeCapability({ capability: 'test.echo', input: {}, idempotencyKey: 'deny-1' })
  assert.equal(operation.status, 'BLOCKED')
  assert.equal(operation.error?.code, 'POLICY_DENIED')
  assert.equal(calls, 0)
})

test('running operation can be cancelled and does not overwrite CANCELLED on late completion', async () => {
  const root = tempRoot()
  const registry = new Zero3CapabilityRegistry()
  registry.register(definition(), async ({ signal }) => await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ tooLate: true }), 500)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
  }))
  const runtime = new Zero3OperationRuntime(registry, new Zero3OperationStore(root), allow, 'node-test')
  const started = await runtime.invokeCapability({ capability: 'test.echo', input: {}, idempotencyKey: 'cancel-1' })
  const cancelled = runtime.cancelOperation({ operationId: started.operationId })
  assert.equal(cancelled.status, 'CANCELLED')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(runtime.getOperation({ operationId: started.operationId }).status, 'CANCELLED')
})

test('persisted non-terminal operations fail closed after a local runtime restart', () => {
  const root = tempRoot()
  const store = new Zero3OperationStore(root, () => '2026-09-12T00:00:00.000Z')
  store.create({
    protocol: 'zero3.remote-capability.v1', operationId: 'op-restart', capability: 'test.echo', nodeId: 'node-test',
    status: 'RUNNING', input: {}, idempotencyKey: 'restart-1', inputFingerprint: 'abc', createdAt: '2026-09-11T00:00:00.000Z',
    startedAt: '2026-09-11T00:00:01.000Z', completedAt: null, progress: 0, result: null, error: null
  })
  const reopened = new Zero3OperationStore(root, () => '2026-09-12T00:00:00.000Z')
  const recovered = reopened.get('op-restart')!
  assert.equal(recovered.status, 'FAILED')
  assert.equal(recovered.error?.code, 'RUNTIME_RESTARTED')
})

test('project_scope never treats PowerShell cwd as a shell sandbox and full_control is explicit', async () => {
  const root = path.resolve(tempRoot())
  const projectPolicy = new EnvironmentZero3CapabilityPolicy({ ZERO3_CAPABILITY_ALLOWED_ROOTS: root, ZERO3_CAPABILITY_POLICY_MODE: 'project_scope' })
  const shell = powerShellDefinition('node-test', 'win32')
  assert.equal((await projectPolicy.authorize({ definition: shell, input: { cwd: path.join(root, 'child') } })).decision, 'require_confirmation')
  assert.equal((await projectPolicy.authorize({ definition: shell, input: { cwd: path.resolve(root, '..', 'outside') } })).decision, 'deny')
  const full = new EnvironmentZero3CapabilityPolicy({ ZERO3_CAPABILITY_POLICY_MODE: 'full_control' })
  assert.equal((await full.authorize({ definition: shell, input: { cwd: 'C:/Windows' } })).decision, 'allow')
})

test('PowerShell capability advertises host availability without pretending Linux can execute it', () => {
  assert.equal(powerShellDefinition('node', 'win32').status, 'available')
  assert.equal(powerShellDefinition('node', 'linux').status, 'unavailable')
})
