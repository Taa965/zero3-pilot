import type { ExecutionExecutorTarget } from './contracts.ts'

export const ZERO3_EXECUTION_ASSIGNMENT_TICKET_V1 = 'zero3.pilot.execution-assignment-ticket.v1' as const
export const ZERO3_EXECUTION_REPORT_V1 = 'zero3.pilot.execution-report.v1' as const
export const ZERO3_EXECUTION_REPORTER_ENDPOINT_V1 = 'zero3.pilot.execution-reporter-endpoint.v1' as const

export type ExecutionReportType =
  | 'SESSION_STARTED'
  | 'PROGRESS_UPDATED'
  | 'ARTIFACT_PRODUCED'
  | 'BLOCKED'
  | 'WAITING_HUMAN'
  | 'COMPLETION_REQUESTED'

export interface ExecutionAssignmentTicketPayload {
  protocol: typeof ZERO3_EXECUTION_ASSIGNMENT_TICKET_V1
  ticketId: string
  taskId: string
  stepId: string
  assignmentId: string
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'>
  attempt: number
  bindingId: string | null
  logicalSessionId: string | null
  allowedReports: readonly ExecutionReportType[]
  issuedAt: string
  expiresAt: string
}

export interface ExecutionReportEnvelope {
  protocol: typeof ZERO3_EXECUTION_REPORT_V1
  reportId: string
  assignmentId: string
  ticket: string
  type: ExecutionReportType
  payload: Readonly<Record<string, unknown>>
  sentAt?: string
}

export interface ExecutionReporterEndpointDescriptor {
  protocol: typeof ZERO3_EXECUTION_REPORTER_ENDPOINT_V1
  origin: string
  bearerToken: string
  pid: number
  startedAt: string
}

export type ExecutionReportNextAction =
  | 'CONTINUE'
  | 'WAIT_FOR_ZERO3_GATE'
  | 'WAIT_FOR_HUMAN'
  | 'FIX_REQUIRED'
  | 'STOP'

export interface ExecutionReportResult {
  accepted: true
  duplicate: boolean
  reportId: string
  taskId: string
  stepId: string
  assignmentId: string
  reportType: ExecutionReportType
  taskStatus: string
  stepStatus: string
  progress: number
  currentActivity: string | null
  nextAction: ExecutionReportNextAction
}

export interface ExecutionReporterContext {
  taskId: string
  taskTitle: string
  taskGoal: string
  stepId: string
  stepTitle: string
  objective: string
  assignmentId: string
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'>
  attempt: number
  bindingId: string | null
  logicalSessionId: string | null
  status: string
  progress: number
  currentActivity: string | null
  inputArtifacts: readonly unknown[]
  expectedOutputs: readonly unknown[]
  completionGate: readonly string[]
}
