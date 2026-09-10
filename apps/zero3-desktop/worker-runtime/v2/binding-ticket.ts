import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  normalizePhysicalWorkerSession,
  normalizeWorkflowWorkerBinding,
  type PhysicalWorkerSession,
  type WorkerProvider,
  type WorkflowWorkerBinding
} from './contracts.ts'

export const ZERO3_WORKER_BINDING_TICKET_PROTOCOL = 'zero3.pilot.worker-binding-ticket.v1' as const
const TICKET_PREFIX = 'z3wbt1'
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/

export type WorkerBindingTicketClaims = {
  protocol: typeof ZERO3_WORKER_BINDING_TICKET_PROTOCOL
  ticketId: string
  workflowRunId: string
  moduleId: string
  moduleVersion: string
  workerDefinitionId: string
  workerSlotId: string
  workerSessionId: string
  provider: WorkerProvider
  allowedCapabilities: string[]
  issuedAt: string
  expiresAt: string
  generation: number
}

export type WorkerBindingTicketExpectedScope = {
  workflowRunId?: string
  workerDefinitionId?: string
  workerSlotId?: string
  workerSessionId?: string
  provider?: WorkerProvider
  generation?: number
  requiredCapability?: string
}

export type WorkerBindingTicketOptions = {
  secret: string | Uint8Array
  clock?: () => Date
  expiresInSeconds?: number
}

function secretBytes(secret: string | Uint8Array): Buffer {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret)
  if (bytes.byteLength < 32) throw new Error('worker binding ticket secret must contain at least 32 bytes')
  return bytes
}

function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function iso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`)
  return parsed.toISOString()
}

function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('worker binding generation is invalid')
  }
  return value
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('allowedCapabilities must contain 1..64 items')
  }
  const normalized = value.map((entry, index) => id(entry, `allowedCapabilities[${index}]`))
  if (new Set(normalized).size !== normalized.length) throw new Error('allowedCapabilities contains duplicates')
  return normalized
}

function signature(payload: string, secret: string | Uint8Array): Buffer {
  return createHmac('sha256', secretBytes(secret)).update(payload).digest()
}

function normalizeClaims(value: unknown): WorkerBindingTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker binding ticket payload is invalid')
  const input = value as Record<string, unknown>
  if (input.protocol !== ZERO3_WORKER_BINDING_TICKET_PROTOCOL) throw new Error('unsupported worker binding ticket protocol')
  if (input.provider !== 'GPT_WEB') throw new Error('worker binding ticket provider is invalid')
  return {
    protocol: ZERO3_WORKER_BINDING_TICKET_PROTOCOL,
    ticketId: id(input.ticketId, 'ticketId'),
    workflowRunId: id(input.workflowRunId, 'workflowRunId'),
    moduleId: id(input.moduleId, 'moduleId'),
    moduleVersion: id(input.moduleVersion, 'moduleVersion'),
    workerDefinitionId: id(input.workerDefinitionId, 'workerDefinitionId'),
    workerSlotId: id(input.workerSlotId, 'workerSlotId'),
    workerSessionId: id(input.workerSessionId, 'workerSessionId'),
    provider: 'GPT_WEB',
    allowedCapabilities: capabilities(input.allowedCapabilities),
    issuedAt: iso(input.issuedAt, 'issuedAt'),
    expiresAt: iso(input.expiresAt, 'expiresAt'),
    generation: generation(input.generation)
  }
}

export function issueWorkerBindingTicket(
  bindingValue: WorkflowWorkerBinding,
  sessionValue: PhysicalWorkerSession,
  options: WorkerBindingTicketOptions
): { ticket: string; claims: WorkerBindingTicketClaims } {
  const binding = normalizeWorkflowWorkerBinding(bindingValue)
  const session = normalizePhysicalWorkerSession(sessionValue)
  if (binding.workerSlotId !== session.workerSlotId) throw new Error('worker session does not belong to binding slot')
  if (session.state === 'LOST' || session.state === 'CLOSED') throw new Error(`cannot issue ticket for ${session.state} worker session`)
  const now = (options.clock ?? (() => new Date()))()
  const ttl = options.expiresInSeconds ?? 3600
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) throw new Error('ticket expiresInSeconds must be 60..86400')
  const claims: WorkerBindingTicketClaims = {
    protocol: ZERO3_WORKER_BINDING_TICKET_PROTOCOL,
    ticketId: `wbt-${randomUUID()}`,
    workflowRunId: binding.workflowRunId,
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    workerDefinitionId: binding.workerDefinitionId,
    workerSlotId: binding.workerSlotId,
    workerSessionId: session.workerSessionId,
    provider: binding.provider,
    allowedCapabilities: [...binding.requiredCapabilities],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    generation: session.generation
  }
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const digest = signature(payload, options.secret).toString('base64url')
  return { ticket: `${TICKET_PREFIX}.${payload}.${digest}`, claims }
}

export function assertWorkerBindingTicketScope(
  claims: WorkerBindingTicketClaims,
  expected: WorkerBindingTicketExpectedScope
): void {
  const exact: Array<[keyof WorkerBindingTicketExpectedScope, string]> = [
    ['workflowRunId', claims.workflowRunId],
    ['workerDefinitionId', claims.workerDefinitionId],
    ['workerSlotId', claims.workerSlotId],
    ['workerSessionId', claims.workerSessionId],
    ['provider', claims.provider]
  ]
  for (const [key, actual] of exact) {
    const wanted = expected[key]
    if (wanted != null && wanted !== actual) throw new Error(`worker binding ticket ${String(key)} scope mismatch`)
  }
  if (expected.generation != null && expected.generation !== claims.generation) {
    throw new Error('worker binding ticket generation is stale')
  }
  if (expected.requiredCapability && !claims.allowedCapabilities.includes(expected.requiredCapability)) {
    throw new Error(`worker binding ticket does not allow capability ${expected.requiredCapability}`)
  }
}

export function verifyWorkerBindingTicket(
  ticket: string,
  options: { secret: string | Uint8Array; clock?: () => Date; expected?: WorkerBindingTicketExpectedScope }
): WorkerBindingTicketClaims {
  const parts = ticket.split('.')
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) throw new Error('worker binding ticket is malformed')
  const expectedSignature = signature(parts[1], options.secret)
  let observed: Buffer
  try { observed = Buffer.from(parts[2], 'base64url') } catch { throw new Error('worker binding ticket signature is malformed') }
  if (observed.byteLength !== expectedSignature.byteLength || !timingSafeEqual(observed, expectedSignature)) {
    throw new Error('worker binding ticket signature is invalid')
  }
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch {
    throw new Error('worker binding ticket payload is invalid')
  }
  const claims = normalizeClaims(decoded)
  const now = (options.clock ?? (() => new Date()))().getTime()
  const issued = new Date(claims.issuedAt).getTime()
  const expires = new Date(claims.expiresAt).getTime()
  if (expires <= issued) throw new Error('worker binding ticket expiry is invalid')
  if (now >= expires) throw new Error('worker binding ticket has expired')
  if (issued > now + 5 * 60 * 1000) throw new Error('worker binding ticket was issued in the future')
  if (options.expected) assertWorkerBindingTicketScope(claims, options.expected)
  return claims
}
