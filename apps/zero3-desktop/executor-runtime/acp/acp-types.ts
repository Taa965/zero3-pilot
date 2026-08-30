import type { ExecutorUsage } from '../executor-types.ts'

export type AcpJsonRpcId = number | string
export type AcpJsonRecord = Record<string, unknown>

export interface AcpAdapterSpec {
  packageRoot: string
  packageName: string
  packageVersion: string
  binName: string
  extraArgs?: readonly string[]
  env?: NodeJS.ProcessEnv
}

export interface ResolvedAcpAdapter {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  packageName: string
  packageVersion: string
}

export interface AcpInitializeSnapshot {
  protocolVersion: number
  loadSession: boolean
  agentName?: string
}

export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind?: string
}

export interface AcpPermissionRequest {
  rpcId: AcpJsonRpcId
  requestKey: string
  sessionId: string
  description: string
  options: readonly AcpPermissionOption[]
}

export type AcpRuntimeEvent =
  | { type: 'message'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'plan'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.updated'; toolCallId: string; detail: string }
  | { type: 'tool.completed'; toolCallId: string; success: boolean }
  | { type: 'file.changed'; path: string }
  | { type: 'permission.requested'; request: AcpPermissionRequest }
  | { type: 'usage.updated'; usage: ExecutorUsage }

export interface AcpSessionMetadata {
  schemaVersion: 'zero3.pilot.acp.session.v1'
  executorId: string
  sessionId: string
  workspace: string
  createdAt: string
}
