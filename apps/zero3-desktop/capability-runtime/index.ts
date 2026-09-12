import path from 'node:path'

import { Zero3OperationRuntime } from './operation-runtime.ts'
import { Zero3OperationStore } from './operation-store.ts'
import { EnvironmentZero3CapabilityPolicy, type Zero3CapabilityPolicyPort } from './policy-port.ts'
import { powerShellDefinition, powerShellHandler } from './powershell-capability.ts'
import { Zero3CapabilityRegistry } from './registry.ts'
import { systemStatusDefinition, systemStatusHandler } from './system-status.ts'

export * from './contracts.ts'
export * from './operation-runtime.ts'
export * from './operation-store.ts'
export * from './policy-port.ts'
export * from './registry.ts'

export type CreateZero3CapabilityRuntimeOptions = {
  root: string
  nodeId: string
  policy?: Zero3CapabilityPolicyPort
  platform?: NodeJS.Platform
}

export function createZero3CapabilityRuntime(options: CreateZero3CapabilityRuntimeOptions): Zero3OperationRuntime {
  const registry = new Zero3CapabilityRegistry()
  const policy = options.policy ?? new EnvironmentZero3CapabilityPolicy()
  registry.register(systemStatusDefinition(options.nodeId), systemStatusHandler(options.nodeId))
  registry.register(powerShellDefinition(options.nodeId, options.platform), powerShellHandler)
  return new Zero3OperationRuntime(
    registry,
    new Zero3OperationStore(path.resolve(options.root)),
    policy,
    options.nodeId
  )
}
