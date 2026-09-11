import { ipcMain } from 'electron'

import type { ExecutionExecutorTarget, ExecutionSessionBindingState, ExecutionStepStatus } from '../contracts.ts'
import type { BindExecutionSessionInput, CreateExecutionTaskInput } from '../runtime.ts'
import type { ExecutionReportType } from '../reporter-contracts.ts'
import type { TaskWorkflowCreateInput } from '../workflows/contracts.ts'
import {
  EXECUTION_DESKTOP_CHANNELS,
  type ExecutionDesktopPort,
  type ExecutionReporterTicketRequest
} from './desktop-port.ts'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u
const EXECUTORS = new Set<Exclude<ExecutionExecutorTarget, 'AUTO'>>([
  'GPT_WEB', 'GEMINI_WEB', 'CODEX', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN'
])
const SESSION_STATES = new Set<ExecutionSessionBindingState>(['created', 'active', 'suspended', 'closed', 'lost'])
const STEP_STATES = new Set<ExecutionStepStatus>([
  'pending', 'waiting_dependency', 'ready', 'dispatching', 'running', 'waiting_report', 'verifying',
  'fix_required', 'waiting_human', 'blocked', 'failed', 'completed', 'cancelled', 'outcome_unknown'
])
const REPORT_TYPES = new Set<ExecutionReportType>([
  'SESSION_STARTED', 'PROGRESS_UPDATED', 'ARTIFACT_PRODUCED', 'BLOCKED', 'WAITING_HUMAN', 'COMPLETION_REQUESTED'
])

function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
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
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
function executor(value: unknown): Exclude<ExecutionExecutorTarget, 'AUTO'> {
  if (typeof value !== 'string' || !EXECUTORS.has(value as Exclude<ExecutionExecutorTarget, 'AUTO'>)) throw new Error('executor is invalid')
  return value as Exclude<ExecutionExecutorTarget, 'AUTO'>
}
function sessionState(value: unknown): ExecutionSessionBindingState {
  if (typeof value !== 'string' || !SESSION_STATES.has(value as ExecutionSessionBindingState)) throw new Error('session state is invalid')
  return value as ExecutionSessionBindingState
}
function stepState(value: unknown): ExecutionStepStatus {
  if (typeof value !== 'string' || !STEP_STATES.has(value as ExecutionStepStatus)) throw new Error('step status is invalid')
  return value as ExecutionStepStatus
}
function ticketRequest(value: unknown): ExecutionReporterTicketRequest {
  if (value == null) return {}
  const input = record(value, 'reporter ticket request')
  const allowedReports = input.allowedReports == null
    ? undefined
    : array(input.allowedReports, 'allowedReports').map(item => {
        if (typeof item !== 'string' || !REPORT_TYPES.has(item as ExecutionReportType)) throw new Error('allowed report type is invalid')
        return item as ExecutionReportType
      })
  return {
    ...(input.ttlSeconds == null ? {} : { ttlSeconds: Number(input.ttlSeconds) }),
    ...(input.bindingId == null ? {} : { bindingId: id(input.bindingId, 'bindingId') }),
    ...(allowedReports ? { allowedReports } : {})
  }
}

export function registerExecutionDesktopIpc(port: ExecutionDesktopPort): () => void {
  const channels = Object.values(EXECUTION_DESKTOP_CHANNELS)
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.runtimeCapabilities, () => port.runtimeCapabilities())
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.skillCapabilities, () => port.skillCapabilities())
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.refreshSkillPreflight, (_event, taskId: unknown) => port.refreshSkillPreflight(id(taskId, 'taskId')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.reconcileReadiness, (_event, taskId: unknown) => port.reconcileReadiness(id(taskId, 'taskId')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.listTasks, () => port.listTasks())
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.getTask, (_event, taskId: unknown) => port.getTask(id(taskId, 'taskId')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.listTaskWorkflows, () => port.listTaskWorkflows())
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.createWorkflowTask, (_event, input: unknown) =>
    port.createWorkflowTask(record(input, 'task workflow input') as unknown as TaskWorkflowCreateInput))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.createTask, (_event, input: unknown) =>
    port.createTask(record(input, 'execution task input') as unknown as CreateExecutionTaskInput))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.addSteps, (_event, taskId: unknown, steps: unknown) =>
    port.addSteps(id(taskId, 'taskId'), array(steps, 'steps').map(item => record(item, 'step'))))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.createAssignment, (_event, taskId: unknown, stepId: unknown, target: unknown, executorId: unknown) =>
    port.createAssignment(id(taskId, 'taskId'), id(stepId, 'stepId'), executor(target), executorId == null ? null : text(executorId, 'executorId', 512)))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.createRoutedAssignment, (_event, taskId: unknown, stepId: unknown, executorId: unknown) =>
    port.createRoutedAssignment(id(taskId, 'taskId'), id(stepId, 'stepId'), executorId == null ? null : text(executorId, 'executorId', 512)))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.bindSession, (_event, assignmentId: unknown, input: unknown) =>
    port.bindSession(id(assignmentId, 'assignmentId'), record(input, 'session binding') as unknown as BindExecutionSessionInput))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.updateSessionState, (_event, taskId: unknown, bindingId: unknown, state: unknown) =>
    port.updateSessionState(id(taskId, 'taskId'), id(bindingId, 'bindingId'), sessionState(state)))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.transitionStep, (_event, taskId: unknown, stepId: unknown, status: unknown, reason: unknown) =>
    port.transitionStep(id(taskId, 'taskId'), id(stepId, 'stepId'), stepState(status), reason == null ? undefined : text(reason, 'reason')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.gatePassed, (_event, taskId: unknown, stepId: unknown, evidence: unknown) =>
    port.gatePassed(id(taskId, 'taskId'), id(stepId, 'stepId'), evidence == null ? {} : record(evidence, 'gate evidence')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.gateFailed, (_event, taskId: unknown, stepId: unknown, reason: unknown) =>
    port.gateFailed(id(taskId, 'taskId'), id(stepId, 'stepId'), text(reason, 'gate failure reason')))
  ipcMain.handle(EXECUTION_DESKTOP_CHANNELS.issueReporterTicket, (_event, assignmentId: unknown, request: unknown) =>
    port.issueReporterTicket(id(assignmentId, 'assignmentId'), ticketRequest(request)))
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
