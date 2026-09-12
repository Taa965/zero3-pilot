import path from 'node:path'

import { createZero3FileSystemCapabilities } from './filesystem-capabilities.ts'
import { createZero3GitCapabilities } from './git-capabilities.ts'
import { Zero3OperationRuntime } from './operation-runtime.ts'
import { Zero3OperationStore } from './operation-store.ts'
import { parseCapabilityAllowedRoots } from './path-safety.ts'
import { EnvironmentZero3CapabilityPolicy, type Zero3CapabilityPolicyPort } from './policy-port.ts'
import { powerShellDefinition, powerShellHandler } from './powershell-capability.ts'
import { Zero3CapabilityRegistry } from './registry.ts'
import { systemStatusDefinition, systemStatusHandler } from './system-status.ts'

export * from './contracts.ts'
export * from './filesystem-capabilities.ts'
export * from './git-capabilities.ts'
export * from './git-runtime.ts'
export * from './operation-runtime.ts'
export * from './operation-store.ts'
export * from './path-safety.ts'
export * from './policy-port.ts'
export * from './registry.ts'

export type CreateZero3CapabilityRuntimeOptions = {
  root: string
  nodeId: string
  policy?: Zero3CapabilityPolicyPort
  platform?: NodeJS.Platform
  cwd?: string
}

/**
 * The local Zero3 Capability Runtime. Registration is the only job here: the
 * AWS gateway, the MCP catalog and the plugin all stay transport-only, so adding
 * a capability is a change to this registry and nothing else.
 */
export function createZero3CapabilityRuntime(options: CreateZero3CapabilityRuntimeOptions): Zero3OperationRuntime {
  const registry = new Zero3CapabilityRegistry()
  const policy = options.policy ?? new EnvironmentZero3CapabilityPolicy()
  const roots = policy.allowedRoots?.() ?? parseCapabilityAllowedRoots(process.env)
  const cwd = options.cwd ?? process.cwd()

  registry.register(systemStatusDefinition(options.nodeId), systemStatusHandler(options.nodeId))
  registry.register(powerShellDefinition(options.nodeId, options.platform), powerShellHandler)

  for (const capability of createZero3FileSystemCapabilities({ nodeId: options.nodeId, roots, cwd })) {
    registry.register(capability.definition, capability.handler)
  }
  for (const capability of createZero3GitCapabilities({ nodeId: options.nodeId, roots, cwd })) {
    registry.register(capability.definition, capability.handler)
  }

  return new Zero3OperationRuntime(
    registry,
    new Zero3OperationStore(path.resolve(options.root)),
    policy,
    options.nodeId
  )
}
