import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { stableJson } from '../group-runtime/store/atomic-file.ts'
import type {
  ExecutionAssignment,
  ExecutionSessionBinding,
  ExecutionStepDefinition,
  ExecutionStepRuntime,
  ExecutionTaskSnapshot
} from './contracts.ts'
import { Zero3ExecutionRuntime } from './runtime.ts'
import {
  ZERO3_EXECUTION_ASSIGNMENT_TICKET_V1,
  ZERO3_EXECUTION_REPORT_V1,
  type ExecutionAssignmentTicketPayload,
  type ExecutionReportEnvelope,
  type ExecutionReportNextAction,
  type ExecutionReportResult,
  type ExecutionReporterContext,
  type ExecutionReportType
} from './reporter-contracts.ts'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u
const TICKET_PREFIX = 'z3r1'
const DEFAULT_TTL_SECONDS = 6 * 60 * 60
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_REPORT_BYTES = 256 * 1024
const ALL_REPORT_TYPES: readonly ExecutionReportType[] = [
  'SESSION_STARTED',
  'PROGRESS_UPDATED',
  'ARTIFACT_PRODUCED',
  'BLOCKED',
  'WAITING_HUMAN',
  'COMPLETION_REQUESTED'
]

export interface IssueExecutionAssignmentTicketOptions {
  ttlSeconds?: number
  bindingId?: string | null
  allowedReports?: readonly ExecutionReportType[]
}

type AssignmentScope = {
  snapshot: ExecutionTaskSnapshot
  assignment: ExecutionAssignment
  step: ExecutionStepDefinition
  runtime: ExecutionStepRuntime
  binding: ExecutionSessionBinding | null
}

function requiredId(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || text.includes('\0')) throw new Error(`${label} is invalid`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null
  return requiredText(value, label, max)
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function reportType(value: unknown): ExecutionReportType {
  if (typeof value !== 'string' || !ALL_REPORT_TYPES.includes(value as ExecutionReportType)) {
    throw new Error('unsupported execution report type')
  }
  return value as ExecutionReportType
}

function parseTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label, 128)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an ISO timestamp`)
  return date.toISOString()
}

function normalizedTtl(value: unknown): number {
  if (value == null) return DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(value) || Number(value) < 60 || Number(value) > MAX_TTL_SECONDS) {
    throw new Error(`ticket ttlSeconds must be between 60 and ${MAX_TTL_SECONDS}`)
  }
  return Number(value)
}

function uniqueReportTypes(value: readonly ExecutionReportType[] | undefined): readonly ExecutionReportType[] {
  const values = value ?? ALL_REPORT_TYPES
  if (!Array.isArray(values) || values.length === 0) throw new Error('ticket must allow at least one report type')
  const normalized = values.map(reportType)
  return [...new Set(normalized)]
}

function reportHash(report: Pick<ExecutionReportEnvelope, 'assignmentId' | 'type' | 'payload'>): string {
  return createHash('sha256').update(stableJson({
    assignmentId: report.assignmentId,
    type: report.type,
    payload: report.payload
  })).digest('hex')
}

function reportEventId(reportId: string): string {
  return `report-${reportId}`
}

function nextAction(stepStatus: string): ExecutionReportNextAction {
  if (stepStatus === 'verifying') return 'WAIT_FOR_ZERO3_GATE'
  if (stepStatus === 'waiting_human') return 'WAIT_FOR_HUMAN'
  if (stepStatus === 'fix_required') return 'FIX_REQUIRED'
  if (['blocked', 'failed', 'cancelled', 'completed', 'outcome_unknown'].includes(stepStatus)) return 'STOP'
  return 'CONTINUE'
}

function resultFor(
  snapshot: ExecutionTaskSnapshot,
  assignment: ExecutionAssignment,
  report: ExecutionReportEnvelope,
  duplicate: boolean
): ExecutionReportResult {
  const step = snapshot.runtime.steps.find(item => item.stepId === assignment.stepId)
  if (!step) throw new Error('execution step runtime disappeared')
  return {
    accepted: true,
    duplicate,
    reportId: report.reportId,
    taskId: assignment.taskId,
    stepId: assignment.stepId,
    assignmentId: assignment.assignmentId,
    reportType: report.type,
    taskStatus: snapshot.runtime.task.status,
    stepStatus: step.status,
    progress: step.progress,
    currentActivity: step.currentActivity,
    nextAction: nextAction(step.status)
  }
}

export class Zero3ExecutionReporter {
  readonly #runtime: Zero3ExecutionRuntime
  readonly #secret: Buffer
  readonly #clock: () => Date

  constructor(runtime: Zero3ExecutionRuntime, secret: Uint8Array, options: { clock?: () => Date } = {}) {
    const key = Buffer.from(secret)
    if (key.byteLength < 32) throw new Error('execution reporter secret must contain at least 32 bytes')
    this.#runtime = runtime
    this.#secret = key
    this.#clock = options.clock ?? (() => new Date())
  }

  async issueTicket(assignmentIdValue: unknown, options: IssueExecutionAssignmentTicketOptions = {}): Promise<string> {
    const assignmentId = requiredId(assignmentIdValue, 'assignmentId')
    const scope = await this.#findAssignment(assignmentId)
    if (scope.runtime.assignmentId !== assignmentId) throw new Error('assignment is stale for the execution step')
    if (['verifying', 'completed', 'cancelled', 'failed', 'outcome_unknown'].includes(scope.runtime.status)) {
      throw new Error(`cannot issue reporter ticket while step is ${scope.runtime.status}`)
    }

    const webExecutor = scope.assignment.executor === 'GPT_WEB' || scope.assignment.executor === 'GEMINI_WEB'
    let binding = scope.binding
    if (options.bindingId) {
      const bindingId = requiredId(options.bindingId, 'bindingId')
      binding = scope.snapshot.runtime.sessionBindings.find(item => item.bindingId === bindingId) ?? null
      if (!binding || binding.assignmentId !== assignmentId) throw new Error('ticket binding does not belong to assignment')
    }
    if (webExecutor && !binding) throw new Error('web execution reporter tickets require a bound session')
    if (binding && (binding.state === 'closed' || binding.state === 'lost')) {
      throw new Error(`cannot issue reporter ticket for ${binding.state} session binding`)
    }

    const issuedAt = this.#clock().toISOString()
    const expiresAt = new Date(this.#clock().getTime() + normalizedTtl(options.ttlSeconds) * 1000).toISOString()
    const payload: ExecutionAssignmentTicketPayload = {
      protocol: ZERO3_EXECUTION_ASSIGNMENT_TICKET_V1,
      ticketId: `ticket-${randomUUID()}`,
      taskId: scope.assignment.taskId,
      stepId: scope.assignment.stepId,
      assignmentId,
      executor: scope.assignment.executor,
      attempt: scope.assignment.attempt,
      bindingId: binding?.bindingId ?? null,
      logicalSessionId: binding?.logicalSessionId ?? null,
      allowedReports: uniqueReportTypes(options.allowedReports),
      issuedAt,
      expiresAt
    }
    return this.#sign(payload)
  }

  async context(ticketValue: unknown): Promise<ExecutionReporterContext> {
    const ticket = this.#verifyTicket(ticketValue)
    const scope = await this.#assertTicketScope(ticket)
    return {
      taskId: scope.assignment.taskId,
      taskTitle: scope.snapshot.definition.task.title,
      taskGoal: scope.snapshot.definition.task.goal,
      stepId: scope.assignment.stepId,
      stepTitle: scope.step.title,
      objective: scope.step.objective,
      assignmentId: scope.assignment.assignmentId,
      executor: scope.assignment.executor,
      attempt: scope.assignment.attempt,
      bindingId: scope.binding?.bindingId ?? null,
      logicalSessionId: scope.binding?.logicalSessionId ?? null,
      status: scope.runtime.status,
      progress: scope.runtime.progress,
      currentActivity: scope.runtime.currentActivity,
      inputArtifacts: scope.step.inputArtifacts,
      expectedOutputs: scope.step.expectedOutputs,
      completionGate: scope.step.completionGate
    }
  }

  async report(value: unknown): Promise<ExecutionReportResult> {
    const report = this.#normalizeReport(value)
    const ticket = this.#verifyTicket(report.ticket)
    if (ticket.assignmentId !== report.assignmentId) throw new Error('report assignment does not match ticket')
    if (!ticket.allowedReports.includes(report.type)) throw new Error(`ticket does not allow ${report.type}`)
    const scope = await this.#assertTicketScope(ticket)
    const hash = reportHash(report)
    const eventId = reportEventId(report.reportId)
    const existing = scope.snapshot.events.find(event => event.eventId === eventId)
    if (existing) {
      if (existing.payload?.reportHash !== hash || existing.payload?.reportType !== report.type) {
        throw new Error('reportId was reused with different report content')
      }
      if (scope.snapshot.runtime.task.lastEventSequence < existing.sequence) {
        throw new Error('execution snapshot requires recovery before this report can be replayed')
      }
      return resultFor(scope.snapshot, scope.assignment, report, true)
    }
    if (['verifying', 'completed', 'cancelled', 'failed', 'outcome_unknown'].includes(scope.runtime.status)) {
      throw new Error(`execution step does not accept new reports while ${scope.runtime.status}`)
    }

    const identity = {
      eventId,
      payload: {
        reportId: report.reportId,
        reportType: report.type,
        reportHash: hash,
        ticketId: ticket.ticketId,
        ...(report.sentAt ? { sentAt: report.sentAt } : {})
      }
    }
    let snapshot: ExecutionTaskSnapshot
    if (report.type === 'SESSION_STARTED') {
      snapshot = await this.#runtime.transitionStep(ticket.taskId, ticket.stepId, 'running', undefined, identity)
    } else if (report.type === 'PROGRESS_UPDATED') {
      const progress = Number(report.payload.progress)
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('progress must be between 0 and 1')
      const activity = optionalText(report.payload.currentActivity, 'currentActivity', 2048)
      snapshot = await this.#runtime.recordProgress(ticket.taskId, ticket.stepId, progress, activity, identity)
    } else if (report.type === 'ARTIFACT_PRODUCED') {
      const artifact = this.#artifactPayload(report.payload)
      snapshot = await this.#runtime.recordArtifact(ticket.taskId, ticket.stepId, artifact, identity)
    } else if (report.type === 'BLOCKED') {
      const reason = requiredText(report.payload.reason, 'blocked reason', 4096)
      snapshot = await this.#runtime.transitionStep(ticket.taskId, ticket.stepId, 'blocked', reason, identity)
    } else if (report.type === 'WAITING_HUMAN') {
      const reason = requiredText(report.payload.reason, 'waiting-human reason', 4096)
      snapshot = await this.#runtime.transitionStep(ticket.taskId, ticket.stepId, 'waiting_human', reason, identity)
    } else {
      snapshot = await this.#runtime.requestCompletion(ticket.taskId, ticket.stepId, identity)
    }
    return resultFor(snapshot, scope.assignment, report, false)
  }

  #normalizeReport(value: unknown): ExecutionReportEnvelope {
    const input = plainRecord(value, 'execution report')
    if (input.protocol !== ZERO3_EXECUTION_REPORT_V1) throw new Error('unsupported execution report protocol')
    const normalized: ExecutionReportEnvelope = {
      protocol: ZERO3_EXECUTION_REPORT_V1,
      reportId: requiredId(input.reportId, 'reportId'),
      assignmentId: requiredId(input.assignmentId, 'assignmentId'),
      ticket: requiredText(input.ticket, 'ticket', 32 * 1024),
      type: reportType(input.type),
      payload: plainRecord(input.payload ?? {}, 'report payload'),
      ...(input.sentAt ? { sentAt: parseTimestamp(input.sentAt, 'sentAt') } : {})
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_REPORT_BYTES) throw new Error('execution report exceeds size limit')
    return normalized
  }

  #artifactPayload(payloadValue: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const payload = plainRecord(payloadValue, 'artifact payload')
    const logicalName = requiredText(payload.logicalName, 'artifact logicalName', 512)
    const artifactId = optionalText(payload.artifactId, 'artifactId', 256)
    const pathOrUri = optionalText(payload.pathOrUri, 'artifact pathOrUri', 8192)
    if (!artifactId && !pathOrUri) throw new Error('artifact report requires artifactId or pathOrUri')
    const hash = optionalText(payload.hash, 'artifact hash', 256)
    const kind = optionalText(payload.kind, 'artifact kind', 128)
    const mimeType = optionalText(payload.mimeType, 'artifact mimeType', 256)
    const sizeBytes = payload.sizeBytes == null ? null : Number(payload.sizeBytes)
    if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) throw new Error('artifact sizeBytes must be a non-negative safe integer')
    const metadata = payload.metadata == null ? null : plainRecord(payload.metadata, 'artifact metadata')
    return {
      logicalName,
      ...(artifactId ? { artifactId } : {}),
      ...(pathOrUri ? { pathOrUri } : {}),
      ...(hash ? { hash } : {}),
      ...(kind ? { kind } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes != null ? { sizeBytes } : {}),
      ...(metadata ? { metadata } : {})
    }
  }

  #sign(payload: ExecutionAssignmentTicketPayload): string {
    const encoded = Buffer.from(stableJson(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', this.#secret).update(encoded).digest('base64url')
    return `${TICKET_PREFIX}.${encoded}.${signature}`
  }

  #verifyTicket(value: unknown): ExecutionAssignmentTicketPayload {
    const ticket = requiredText(value, 'ticket', 32 * 1024)
    const parts = ticket.split('.')
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) throw new Error('execution reporter ticket is malformed')
    const expected = createHmac('sha256', this.#secret).update(parts[1]).digest()
    let observed: Buffer
    try { observed = Buffer.from(parts[2], 'base64url') } catch { throw new Error('execution reporter ticket signature is malformed') }
    if (observed.byteLength !== expected.byteLength || !timingSafeEqual(observed, expected)) throw new Error('execution reporter ticket signature is invalid')
    let payload: ExecutionAssignmentTicketPayload
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as ExecutionAssignmentTicketPayload }
    catch { throw new Error('execution reporter ticket payload is invalid') }
    if (payload?.protocol !== ZERO3_EXECUTION_ASSIGNMENT_TICKET_V1) throw new Error('unsupported execution reporter ticket protocol')
    requiredId(payload.ticketId, 'ticketId')
    requiredId(payload.taskId, 'ticket taskId')
    requiredId(payload.stepId, 'ticket stepId')
    requiredId(payload.assignmentId, 'ticket assignmentId')
    if (!Number.isSafeInteger(payload.attempt) || payload.attempt < 1) throw new Error('ticket attempt is invalid')
    if (payload.bindingId != null) requiredId(payload.bindingId, 'ticket bindingId')
    if (payload.logicalSessionId != null) requiredText(payload.logicalSessionId, 'ticket logicalSessionId', 512)
    uniqueReportTypes(payload.allowedReports)
    const issuedAt = new Date(parseTimestamp(payload.issuedAt, 'ticket issuedAt')).getTime()
    const expiresAt = new Date(parseTimestamp(payload.expiresAt, 'ticket expiresAt')).getTime()
    const current = this.#clock().getTime()
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_SECONDS * 1000) throw new Error('ticket lifetime is invalid')
    if (current >= expiresAt) throw new Error('execution reporter ticket has expired')
    if (issuedAt > current + 5 * 60 * 1000) throw new Error('execution reporter ticket was issued in the future')
    return payload
  }

  async #findAssignment(assignmentId: string): Promise<AssignmentScope> {
    for (const taskId of await this.#runtime.store.listTaskIds()) {
      const snapshot = await this.#runtime.snapshot(taskId)
      const assignment = snapshot.runtime.assignments.find(item => item.assignmentId === assignmentId)
      if (!assignment) continue
      const step = snapshot.definition.steps.find(item => item.stepId === assignment.stepId)
      const runtime = snapshot.runtime.steps.find(item => item.stepId === assignment.stepId)
      if (!step || !runtime) throw new Error('execution assignment refers to missing step')
      const binding = snapshot.runtime.sessionBindings.find(item => item.assignmentId === assignmentId && item.state !== 'closed') ?? null
      return { snapshot, assignment, step, runtime, binding }
    }
    throw new Error('execution assignment was not found')
  }

  async #assertTicketScope(ticket: ExecutionAssignmentTicketPayload): Promise<AssignmentScope> {
    const scope = await this.#findAssignment(ticket.assignmentId)
    if (
      scope.assignment.taskId !== ticket.taskId ||
      scope.assignment.stepId !== ticket.stepId ||
      scope.assignment.executor !== ticket.executor ||
      scope.assignment.attempt !== ticket.attempt
    ) throw new Error('execution reporter ticket scope no longer matches assignment')
    if (scope.runtime.assignmentId !== ticket.assignmentId) throw new Error('execution reporter ticket belongs to a stale assignment')
    if (ticket.bindingId) {
      const binding = scope.snapshot.runtime.sessionBindings.find(item => item.bindingId === ticket.bindingId) ?? null
      if (!binding || binding.assignmentId !== ticket.assignmentId) throw new Error('execution reporter ticket binding is no longer available')
      if (binding.logicalSessionId !== ticket.logicalSessionId) throw new Error('execution reporter ticket session identity changed')
      if (binding.state === 'closed' || binding.state === 'lost') throw new Error(`execution reporter session is ${binding.state}`)
      scope.binding = binding
    }
    return scope
  }
}
