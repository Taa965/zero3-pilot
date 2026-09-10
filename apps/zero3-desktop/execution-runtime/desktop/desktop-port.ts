import type { ExecutionExecutorTarget, ExecutionSessionBindingState, ExecutionStepStatus } from '../contracts.ts'
import type { BindExecutionSessionInput, CreateExecutionTaskInput } from '../runtime.ts'
import type { ExecutionReportType } from '../reporter-contracts.ts'

export interface ExecutionReporterTicketRequest {
  ttlSeconds?: number
  bindingId?: string | null
  allowedReports?: readonly ExecutionReportType[]
}

export interface ExecutionDesktopReporterAccess {
  ticket: string
  endpointFile: string
  client: {
    kind: 'node' | 'powershell'
    command: string
    argsPrefix: readonly string[]
  }
}

export interface ExecutionDesktopPort {
  start(): Promise<void>
  stop(): Promise<void>
  runtimeCapabilities(): Promise<unknown>
  listTasks(): Promise<unknown>
  getTask(taskId: string): Promise<unknown>
  createTask(input: CreateExecutionTaskInput): Promise<unknown>
  addSteps(taskId: string, steps: readonly Record<string, unknown>[]): Promise<unknown>
  createAssignment(taskId: string, stepId: string, executor: Exclude<ExecutionExecutorTarget, 'AUTO'>, executorId?: string | null): Promise<unknown>
  bindSession(assignmentId: string, input: BindExecutionSessionInput): Promise<unknown>
  updateSessionState(taskId: string, bindingId: string, state: ExecutionSessionBindingState): Promise<unknown>
  transitionStep(taskId: string, stepId: string, status: ExecutionStepStatus, reason?: string): Promise<unknown>
  gatePassed(taskId: string, stepId: string, evidence?: Readonly<Record<string, unknown>>): Promise<unknown>
  gateFailed(taskId: string, stepId: string, reason: string): Promise<unknown>
  issueReporterTicket(assignmentId: string, request?: ExecutionReporterTicketRequest): Promise<ExecutionDesktopReporterAccess>
}

export const EXECUTION_DESKTOP_CHANNELS = {
  runtimeCapabilities: 'zero3:execution:runtime-capabilities',
  listTasks: 'zero3:execution:list',
  getTask: 'zero3:execution:get',
  createTask: 'zero3:execution:create',
  addSteps: 'zero3:execution:add-steps',
  createAssignment: 'zero3:execution:create-assignment',
  bindSession: 'zero3:execution:bind-session',
  updateSessionState: 'zero3:execution:update-session-state',
  transitionStep: 'zero3:execution:transition-step',
  gatePassed: 'zero3:execution:gate-passed',
  gateFailed: 'zero3:execution:gate-failed',
  issueReporterTicket: 'zero3:execution:issue-reporter-ticket'
} as const
