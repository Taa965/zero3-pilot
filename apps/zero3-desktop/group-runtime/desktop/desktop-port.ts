export interface DevelopmentGroupDesktopPort {
  listGroups(): Promise<unknown>
  getGroup(groupId: string): Promise<unknown>
  createGroup(request: unknown, proposal: unknown): Promise<unknown>
  startWave(groupId: string, waveId: string): Promise<unknown>
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
  integrateDelivery: 'zero3:development-group:integrate-delivery',
  runVerification: 'zero3:development-group:run-verification',
  getCompletionProof: 'zero3:development-group:completion-proof',
  completeGroup: 'zero3:development-group:complete'
} as const
