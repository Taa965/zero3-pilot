import { dialog, ipcMain } from 'electron'

import type { WorkflowArtifactSeed } from '../contracts.ts'
import type { CreateWorkflowRunRequest } from '../runtime.ts'
import { WORKFLOW_DESKTOP_CHANNELS, type WorkflowDesktopPort } from './desktop-port.ts'

const ID = /^[A-Za-z0-9._:-]{1,256}$/u
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function text(value: unknown, label: string, max = 4096): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max || result.includes('\0')) throw new Error(`${label} is invalid`)
  return result
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map(item => record(item, `${label} item`))
}

export function registerWorkflowDesktopIpc(port: WorkflowDesktopPort): () => void {
  const channels = Object.values(WORKFLOW_DESKTOP_CHANNELS)
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.runtimeCapabilities, () => port.runtimeCapabilities())
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.listModules, () => port.listModules())
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.validateCreateInput, (_event, moduleId: unknown, input: unknown, moduleVersion: unknown) =>
    port.validateCreateInput(id(moduleId, 'moduleId'), input, moduleVersion == null ? null : text(moduleVersion, 'moduleVersion', 128)))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.listRuns, () => port.listRuns())
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.getRun, (_event, runId: unknown) => port.getRun(id(runId, 'workflowRunId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.createRun, (_event, requestValue: unknown) => {
    const request = record(requestValue, 'workflow run request')
    return port.createRun({
      moduleId: id(request.moduleId, 'moduleId'),
      ...(request.moduleVersion == null ? {} : { moduleVersion: text(request.moduleVersion, 'moduleVersion', 128) }),
      input: request.input,
      start: request.start !== false
    } as CreateWorkflowRunRequest)
  })
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.startRun, (_event, runId: unknown) => port.startRun(id(runId, 'workflowRunId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.readyStages, (_event, runId: unknown, workerId: unknown) =>
    port.readyStages(id(runId, 'workflowRunId'), workerId == null ? null : id(workerId, 'workerDefinitionId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.claimStage, (_event, runId: unknown, stageRunId: unknown, ownerId: unknown) =>
    port.claimStage(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), id(ownerId, 'ownerId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.startStage, (_event, runId: unknown, stageRunId: unknown, ownerId: unknown) =>
    port.startStage(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), ownerId == null ? null : id(ownerId, 'ownerId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.reportProgress, (_event, runId: unknown, stageRunId: unknown, progress: unknown, activity: unknown) =>
    port.reportProgress(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), Number(progress), activity == null ? null : text(activity, 'activity', 2048)))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.requestVerification, (_event, runId: unknown, stageRunId: unknown, artifactsValue: unknown) =>
    port.requestVerification(
      id(runId, 'workflowRunId'),
      id(stageRunId, 'stageRunId'),
      (artifactsValue == null ? [] : records(artifactsValue, 'artifacts')) as unknown as WorkflowArtifactSeed[]
    ))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.gatePassed, (_event, runId: unknown, stageRunId: unknown, evidence: unknown) =>
    port.gatePassed(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), evidence == null ? {} : record(evidence, 'evidence')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.gateFailed, (_event, runId: unknown, stageRunId: unknown, reason: unknown) =>
    port.gateFailed(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), text(reason, 'reason')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.blockStage, (_event, runId: unknown, stageRunId: unknown, reason: unknown, waitingHuman: unknown) =>
    port.blockStage(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId'), text(reason, 'reason'), waitingHuman === true))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.resumeStage, (_event, runId: unknown, stageRunId: unknown) =>
    port.resumeStage(id(runId, 'workflowRunId'), id(stageRunId, 'stageRunId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.ingestInputs, (_event, runId: unknown) =>
    port.ingestInputs(id(runId, 'workflowRunId')))
  ipcMain.handle(WORKFLOW_DESKTOP_CHANNELS.pickInputFiles, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择工作流输入脚本',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '脚本文件', extensions: ['txt', 'md', 'docx', 'rtf'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths.map(path => ({ path, name: path.replace(/\\/gu, '/').split('/').at(-1) ?? path }))
  })
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
