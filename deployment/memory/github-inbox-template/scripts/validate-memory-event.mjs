import fs from 'node:fs'
import path from 'node:path'

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

function fail(message) {
  console.error(`Zero3 Memory Inbox validation failed: ${message}`)
  process.exit(1)
}

function scan(value, currentPath = '$', findings = []) {
  if (value == null) return findings
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${currentPath}[${index}]`, findings))
    return findings
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) findings.push(`${currentPath}.${key}: forbidden key`)
      scan(item, `${currentPath}.${key}`, findings)
    }
    return findings
  }
  if (typeof value === 'string' && SECRET_PATTERNS.some(pattern => pattern.test(value))) {
    findings.push(`${currentPath}: secret-like value`)
  }
  return findings
}

const file = process.argv[2]
if (!file) fail('usage: node validate-memory-event.mjs <event-file>')

const normalized = file.replaceAll('\\', '/')
const match = /^events\/([A-Za-z0-9._:-]{1,256})\/(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-fA-F-]{36})\.json$/.exec(normalized)
if (!match) fail(`path is not allowlisted: ${normalized}`)

const [, projectId, , , pathEventId] = match
let event
try {
  const bytes = fs.statSync(file).size
  if (bytes > 256 * 1024) fail(`event exceeds 256 KiB: ${bytes} bytes`)
  event = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

const required = ['schema','event_id','created_at','scope','actor','event_type','memory','source','supersedes','payload']
for (const key of required) if (!Object.hasOwn(event, key)) fail(`missing required field ${key}`)
if (event.schema !== 'zero3.memory.event.v1') fail('unsupported schema')
if (String(event.event_id).toLowerCase() !== pathEventId.toLowerCase()) fail('event_id must match filename')
if (event.scope?.project_id !== projectId) fail('scope.project_id must match path')
if (event.actor?.agent_type !== 'gpt_web') fail('GitHub inbox accepts only gpt_web actor_type')
if (event.source?.type !== 'github_inbox') fail('GitHub inbox events require source.type=github_inbox')
if (event.memory?.class === 'personal') fail('personal memory is forbidden in GitHub inbox')
if (!Number.isInteger(event.memory?.authority) || event.memory.authority < 0 || event.memory.authority > 60) fail('GitHub inbox authority must be 0..60')
if (!Array.isArray(event.supersedes) || typeof event.payload !== 'object' || event.payload == null || Array.isArray(event.payload)) fail('invalid supersedes/payload')

const findings = scan(event)
if (findings.length) fail(findings.join('; '))

console.log(JSON.stringify({ ok: true, file: path.normalize(file), event_id: event.event_id, project_id: projectId }))
