#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const REPORT_PROTOCOL = 'zero3.pilot.execution-report.v1'
const ENDPOINT_PROTOCOL = 'zero3.pilot.execution-reporter-endpoint.v1'

function usage() {
  return `Usage:
  zero3-exec.mjs context --endpoint-file <path> --ticket <ticket>
  zero3-exec.mjs report --endpoint-file <path> --ticket <ticket> --report-id <id> --type <type> [--assignment-id <id>] [--payload-json <json>]

Environment fallbacks:
  ZERO3_REPORTER_ENDPOINT_FILE
  ZERO3_ASSIGNMENT_TICKET
`
}

function parseArgs(argv) {
  const command = argv[0]
  const values = new Map()
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value == null) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    values.set(flag.slice(2), value)
  }
  return { command, values }
}

function required(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

function ticketPayload(ticket) {
  const parts = ticket.split('.')
  if (parts.length !== 3 || parts[0] !== 'z3r1') throw new Error('ticket is malformed')
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) }
  catch { throw new Error('ticket payload is malformed') }
}

async function descriptor(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed?.protocol !== ENDPOINT_PROTOCOL || typeof parsed.origin !== 'string' || typeof parsed.bearerToken !== 'string') {
    throw new Error('reporter endpoint descriptor is invalid')
  }
  const origin = new URL(parsed.origin)
  if (origin.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]'].includes(origin.hostname)) {
    throw new Error('reporter endpoint must be loopback HTTP')
  }
  return parsed
}

async function post(endpoint, pathname, body) {
  const response = await fetch(new URL(pathname, endpoint.origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.bearerToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  })
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : {} } catch { value = { error: text || `HTTP ${response.status}` } }
  if (!response.ok) throw new Error(value?.error || `reporter returned HTTP ${response.status}`)
  return value
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2))
  if (command !== 'report' && command !== 'context') throw new Error(usage())
  const endpointFile = required(values.get('endpoint-file') ?? process.env.ZERO3_REPORTER_ENDPOINT_FILE, 'endpoint-file')
  const ticket = required(values.get('ticket') ?? process.env.ZERO3_ASSIGNMENT_TICKET, 'ticket')
  const endpoint = await descriptor(endpointFile)
  if (command === 'context') return post(endpoint, '/v1/context', { ticket })

  const decoded = ticketPayload(ticket)
  const assignmentId = required(values.get('assignment-id') ?? decoded.assignmentId, 'assignment-id')
  const reportId = required(values.get('report-id'), 'report-id')
  const type = required(values.get('type'), 'type')
  let payload = {}
  const payloadJson = values.get('payload-json')
  if (payloadJson) {
    payload = JSON.parse(payloadJson)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload-json must decode to an object')
  }
  return post(endpoint, '/v1/report', {
    protocol: REPORT_PROTOCOL,
    reportId,
    assignmentId,
    ticket,
    type,
    payload,
    sentAt: new Date().toISOString()
  })
}

main().then(value => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}).catch(error => {
  process.stderr.write(`zero3-exec: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
