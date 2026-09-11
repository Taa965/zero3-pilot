import os from 'node:os'

import type { Zero3CapabilityDefinition, Zero3CapabilityHandler } from './contracts.ts'

export function systemStatusDefinition(nodeId: string): Zero3CapabilityDefinition {
  return {
    protocol: 'zero3.remote-capability.v1',
    id: 'system.status',
    version: '1.0',
    name: 'Zero3 Local System Status',
    description: 'Return bounded, non-secret status for the local Zero3 runtime and host.',
    category: 'system',
    status: 'available',
    executionMode: 'local',
    supportsStreaming: false,
    supportsCancellation: false,
    requiresApproval: 'none',
    provider: 'zero3-local',
    nodeId,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' },
        hostname: { type: 'string' }, nodeVersion: { type: 'string' }, pid: { type: 'integer' },
        uptimeSeconds: { type: 'number' }, cwd: { type: 'string' }, timestamp: { type: 'string' }
      }
    }
  }
}

export function systemStatusHandler(nodeId: string): Zero3CapabilityHandler {
  return async () => ({
    nodeId,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    cwd: process.cwd(),
    timestamp: new Date().toISOString()
  })
}
