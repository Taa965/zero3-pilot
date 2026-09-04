import { ipcMain } from 'electron'

import type { ExecutorPermissionResponse } from '../../executor-runtime/executor-types.ts'
import {
  DEVELOPMENT_GROUP_DESKTOP_CHANNELS,
  type DevelopmentGroupDesktopPort,
  type DevelopmentGroupOutcomeResolution
} from './desktop-port.ts'

const ID_MAX = 160

function requiredId(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > ID_MAX || /[\0\r\n]/u.test(text)) throw new Error(`${label} is required and must be at most ${ID_MAX} safe characters`)
  return text
}

function requiredText(value: unknown, label: string, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || /[\0]/u.test(text)) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function permissionResponse(value: unknown): ExecutorPermissionResponse {
  const record = plainRecord(value, 'permission response')
  const requestId = requiredId(record.requestId, 'permission requestId')
  const decision = record.decision
  if (decision !== 'approve_once' && decision !== 'approve_session' && decision !== 'deny') {
    throw new Error('permission decision must be approve_once, approve_session, or deny')
  }
  return { requestId, decision }
}

function outcomeResolution(value: unknown): DevelopmentGroupOutcomeResolution {
  if (value !== 'failed' && value !== 'cancelled' && value !== 'superseded') {
    throw new Error('OutcomeUnknown resolution must be failed, cancelled, or superseded')
  }
  return value
}

export function registerDevelopmentGroupDesktopIpc(port: DevelopmentGroupDesktopPort): () => void {
  const channels = Object.values(DEVELOPMENT_GROUP_DESKTOP_CHANNELS)
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.listGroups, () => port.listGroups())
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.getGroup, (_event, groupId: unknown) => port.getGroup(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.createGroup, (_event, request: unknown, proposal: unknown) =>
    port.createGroup(plainRecord(request, 'Planning request'), plainRecord(proposal, 'Planning proposal')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.startWave, (_event, groupId: unknown, waveId: unknown) =>
    port.startWave(requiredId(groupId, 'groupId'), requiredId(waveId, 'waveId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.retrySession, (_event, groupId: unknown, sessionId: unknown) =>
    port.retrySession(requiredId(groupId, 'groupId'), requiredId(sessionId, 'sessionId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.respondPermission, (_event, groupId: unknown, sessionId: unknown, response: unknown) =>
    port.respondPermission(requiredId(groupId, 'groupId'), requiredId(sessionId, 'sessionId'), permissionResponse(response)))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.cancelSession, (_event, groupId: unknown, sessionId: unknown) =>
    port.cancelSession(requiredId(groupId, 'groupId'), requiredId(sessionId, 'sessionId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.resolveOutcomeUnknown, (_event, groupId: unknown, sessionId: unknown, resolution: unknown, evidence: unknown) =>
    port.resolveOutcomeUnknown(
      requiredId(groupId, 'groupId'),
      requiredId(sessionId, 'sessionId'),
      outcomeResolution(resolution),
      requiredText(evidence, 'OutcomeUnknown recovery evidence')
    ))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.integrateDelivery, (_event, groupId: unknown, sessionId: unknown) =>
    port.integrateDelivery(requiredId(groupId, 'groupId'), requiredId(sessionId, 'sessionId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.runVerification, (_event, groupId: unknown) => port.runVerification(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.getCompletionProof, (_event, groupId: unknown) => port.getCompletionProof(requiredId(groupId, 'groupId')))
  ipcMain.handle(DEVELOPMENT_GROUP_DESKTOP_CHANNELS.completeGroup, (_event, groupId: unknown) => port.completeGroup(requiredId(groupId, 'groupId')))
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
