import type { ExecutorPermissionResponse } from '../../executor-runtime/executor-types.ts'

export type DevelopmentGroupOutcomeResolution = 'failed' | 'cancelled' | 'superseded'

export interface DevelopmentGroupDesktopPort {
  listGroups(): Promise<unknown>
  getGroup(groupId: string): Promise<unknown>
  createGroup(request: unknown, proposal: unknown): Promise<unknown>
  startWave(groupId: string, waveId: string): Promise<unknown>
  retrySession(groupId: string, sessionId: string): Promise<unknown>
  respondPermission(groupId: string, sessionId: string, response: ExecutorPermissionResponse): Promise<void>
  cancelSession(groupId: string, sessionId: string): Promise<void>
  resolveOutcomeUnknown(groupId: string, sessionId: string, resolution: DevelopmentGroupOutcomeResolution, evidence: string): Promise<unknown>
  integrateDelivery(groupId: string, sessionId: string): Promise<unknown>
  runVerification(groupId: string): Promise<unknown>
  getCompletionProof(groupId: string): Promise<unknown>
  completeGroup(groupId: string): Promise<unknown>
}

export const DEVELOPMENT_GROUP_DESKTOP_CHANNELS = {
  listGroups: 'zero3:development-group:list',
  getGroup: 'zero3:development-group:get',
  createGroup: 'zero3:development-group:create',
  startWave: 'zero3:development-group:start-wave',
  retrySession: 'zero3:development-group:retry-session',
  respondPermission: 'zero3:development-group:respond-permission',
  cancelSession: 'zero3:development-group:cancel-session',
  resolveOutcomeUnknown: 'zero3:development-group:resolve-outcome-unknown',
  integrateDelivery: 'zero3:development-group:integrate-delivery',
  runVerification: 'zero3:development-group:run-verification',
  getCompletionProof: 'zero3:development-group:completion-proof',
  completeGroup: 'zero3:development-group:complete'
} as const
