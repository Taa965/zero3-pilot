import { createHmac, timingSafeEqual } from 'node:crypto'

const FORBIDDEN_KEYS = /^(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|session[_-]?cookie|private[_-]?key|client[_-]?secret|bearer)$/i
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
]

export class GithubMemoryInboxError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GithubMemoryInboxError'
    this.code = code
    this.details = details
  }
}

export function verifyGithubSignature(body, signature, secret) {
  if (typeof secret !== 'string' || !secret) throw new GithubMemoryInboxError('missing_webhook_secret', 'webhook secret is required')
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function findSecrets(value, path = '$', findings = []) {
  if (value == null) return findings
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecrets(item, `${path}[${index}]`, findings))
    return findings
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) findings.push({ path: `${path}.${key}`, reason: 'forbidden_key' })
      findSecrets(item, `${path}.${key}`, findings)
    }
    return findings
  }
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({ path, reason: 'secret_pattern' })
        break
      }
    }
  }
  return findings
}

export function assertSecretFree(value) {
  const findings = findSecrets(value)
  if (findings.length) {
    throw new GithubMemoryInboxError('secret_detected', 'memory event contains data forbidden from GitHub/shared memory ingress', { findings })
  }
  return value
}

export function parseInboxPath(path) {
  const match = /^events\/([A-Za-z0-9._:-]{1,256})\/(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-fA-F-]{36})\.json$/.exec(path ?? '')
  if (!match) throw new GithubMemoryInboxError('invalid_inbox_path', 'memory inbox path is not allowlisted')
  return { project_id: match[1], year: match[2], month: match[3], event_id: match[4].toLowerCase() }
}

export function validateGithubIngress(input) {
  const { deliveryId, repo, branch, path, event, allowedRepo, allowedBranch = 'main' } = input ?? {}
  if (typeof deliveryId !== 'string' || !deliveryId) throw new GithubMemoryInboxError('invalid_delivery', 'GitHub delivery id is required')
  if (repo !== allowedRepo) throw new GithubMemoryInboxError('repo_denied', 'GitHub repository is not allowlisted')
  if (branch !== allowedBranch) throw new GithubMemoryInboxError('branch_denied', 'GitHub branch is not allowlisted')
  const parsed = parseInboxPath(path)
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new GithubMemoryInboxError('invalid_event', 'memory event must be an object')
  if (event.schema !== 'zero3.memory.event.v1') throw new GithubMemoryInboxError('invalid_event', 'unsupported memory event schema')
  if (String(event.event_id ?? '').toLowerCase() !== parsed.event_id) throw new GithubMemoryInboxError('event_id_mismatch', 'event id must match inbox filename')
  if (event.scope?.project_id !== parsed.project_id) throw new GithubMemoryInboxError('project_mismatch', 'event project must match inbox path')
  if (event.actor?.agent_type !== 'gpt_web') throw new GithubMemoryInboxError('actor_denied', 'GitHub web ingress is reserved for gpt_web actor events')
  if (event.source?.type !== 'github_inbox') throw new GithubMemoryInboxError('source_denied', 'GitHub ingress event source must be github_inbox')
  if (!Number.isInteger(event.memory?.authority) || event.memory.authority < 0 || event.memory.authority > 60) {
    throw new GithubMemoryInboxError('authority_denied', 'GitHub web ingress authority must be between 0 and 60')
  }
  if (event.memory?.class === 'personal') throw new GithubMemoryInboxError('personal_denied', 'personal memory must never transit the GitHub inbox')
  assertSecretFree(event)
  return { delivery_id: deliveryId, repo, branch, path, parsed, event }
}

export class InMemoryGithubReceiptStore {
  #receipts = new Map()

  get(deliveryId) { return this.#receipts.get(deliveryId) ?? null }
  put(deliveryId, receipt) {
    if (this.#receipts.has(deliveryId)) return false
    this.#receipts.set(deliveryId, structuredClone(receipt))
    return true
  }
}

export async function ingestGithubDelivery(input, { receipts, appendEvent }) {
  if (!receipts || typeof receipts.get !== 'function' || typeof receipts.put !== 'function') {
    throw new GithubMemoryInboxError('invalid_receipt_store', 'receipt store must implement get/put')
  }
  if (typeof appendEvent !== 'function') throw new GithubMemoryInboxError('invalid_authority_sink', 'appendEvent callback is required')

  const existing = receipts.get(input.deliveryId)
  if (existing) return { status: 'duplicate_delivery', ...existing }
  const validated = validateGithubIngress(input)
  const result = await appendEvent(validated.event)
  const receipt = {
    event_id: validated.event.event_id,
    sequence: result.sequence ?? null,
    path: validated.path,
    commit_sha: input.commitSha ?? null
  }
  receipts.put(validated.delivery_id, receipt)
  return { status: 'ingested', ...receipt }
}
