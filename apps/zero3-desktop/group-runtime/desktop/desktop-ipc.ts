import { ipcMain } from 'electron'

import { DEVELOPMENT_GROUP_DESKTOP_CHANNELS, type DevelopmentGroupDesktopPort } from './desktop-port.ts'

const ID_MAX = 160

function requiredId(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > ID_MAX || /[\0\r\n]/u.test(text)) throw new Error(`${label} is required and must be at most ${ID_MAX} safe characters`)
  return text
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function registerDevelopmentGroupDesktopIpc(port: DevelopmentGroupDesktopPort): () => void {
  const channels = Object.values(DEVELOPMENT_GROUP_DESKTOP_CHANNELS)
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.listGroups, () => port.listGroups())
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.getGroup, (_event, groupId: unknown) => port.getGroup(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.createGroup, (_event, request: unknown, proposal: unknown) =>
    port.createGroup(plainRecord(request, 'Planning request'), plainRecord(proposal, 'Planning proposal')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.startWave, (_event, groupId: unknown, waveId: unknown) =>
    port.startWave(requiredId(groupId, 'groupId'), requiredId(waveId, 'waveId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.integrateDelivery, (_event, groupId: unknown, sessionId: unknown) =>
    port.integrateDelivery(requiredId(groupId, 'groupId'), requiredId(sessionId, 'sessionId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.runVerification, (_event, groupId: unknown) => port.runVerification(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.getCompletionProof, (_event, groupId: unknown) => port.getCompletionProof(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.completeGroup, (_event, groupId: unknown) => port.completeGroup(requiredId(groupId, 'groupId')))
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
