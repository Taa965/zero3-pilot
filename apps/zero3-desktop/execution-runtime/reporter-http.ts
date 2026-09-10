import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  ZERO3_EXECUTION_REPORTER_ENDPOINT_V1,
  type ExecutionReporterEndpointDescriptor
} from './reporter-contracts.ts'
import { Zero3ExecutionReporter } from './reporter.ts'

const MAX_BODY_BYTES = 512 * 1024

export interface ExecutionReporterHttpServerOptions {
  host?: string
  port?: number
  descriptorPath?: string | null
  bearerToken?: string
}

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(`${JSON.stringify(value)}\n`)
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('request body exceeds size limit')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('request body must be valid JSON') }
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (/ticket.*(signature|expired|malformed|scope|stale|session)|authorization|bearer/iu.test(message)) return 403
  if (/not found/iu.test(message)) return 404
  if (/size limit/iu.test(message)) return 413
  return 400
}

export class Zero3ExecutionReporterHttpServer {
  readonly #reporter: Zero3ExecutionReporter
  readonly #host: string
  readonly #port: number
  readonly #descriptorPath: string | null
  readonly #bearerToken: string
  #server: Server | null = null
  #descriptor: ExecutionReporterEndpointDescriptor | null = null

  constructor(reporter: Zero3ExecutionReporter, options: ExecutionReporterHttpServerOptions = {}) {
    this.#reporter = reporter
    this.#host = options.host ?? '127.0.0.1'
    if (this.#host !== '127.0.0.1' && this.#host !== '::1') throw new Error('execution reporter HTTP server must bind loopback')
    this.#port = options.port ?? 0
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65_535) throw new Error('execution reporter port is invalid')
    this.#descriptorPath = options.descriptorPath ?? null
    this.#bearerToken = options.bearerToken?.trim() || randomBytes(32).toString('base64url')
  }

  descriptor(): ExecutionReporterEndpointDescriptor | null {
    return this.#descriptor ? { ...this.#descriptor } : null
  }

  async start(): Promise<ExecutionReporterEndpointDescriptor> {
    if (this.#server && this.#descriptor) return { ...this.#descriptor }
    const server = createServer((request, response) => { void this.#handle(request, response) })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.removeListener('listening', ready); reject(error) }
      const ready = () => { server.removeListener('error', fail); resolve() }
      server.once('error', fail)
      server.once('listening', ready)
      server.listen(this.#port, this.#host)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('execution reporter HTTP server did not expose a TCP address')
    }
    this.#server = server
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    const descriptor: ExecutionReporterEndpointDescriptor = {
      protocol: ZERO3_EXECUTION_REPORTER_ENDPOINT_V1,
      origin: `http://${host}:${address.port}`,
      bearerToken: this.#bearerToken,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }
    this.#descriptor = descriptor
    if (this.#descriptorPath) {
      await mkdir(dirname(this.#descriptorPath), { recursive: true, mode: 0o700 })
      await writeFile(this.#descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    return { ...descriptor }
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.#descriptor = null
    if (server) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    if (this.#descriptorPath) await rm(this.#descriptorPath, { force: true }).catch(() => undefined)
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        json(response, 200, { ok: true, service: 'zero3-execution-reporter', protocol: ZERO3_EXECUTION_REPORTER_ENDPOINT_V1 })
        return
      }
      if (request.method !== 'POST' || (request.url !== '/v1/report' && request.url !== '/v1/context')) {
        json(response, 404, { error: 'not_found' })
        return
      }
      if (bearer(request) !== this.#bearerToken) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      const body = await readJsonBody(request)
      if (request.url === '/v1/report') {
        json(response, 200, await this.#reporter.report(body))
        return
      }
      const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      json(response, 200, await this.#reporter.context(value.ticket))
    } catch (error) {
      json(response, errorStatus(error), { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
