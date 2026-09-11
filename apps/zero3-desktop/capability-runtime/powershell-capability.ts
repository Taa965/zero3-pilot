import { spawn } from 'node:child_process'

import { resolveWindowsCommand } from '../executor-runtime/external/windows-command.ts'
import { probeShellCapabilities } from '../executor-runtime/shell/shell-capabilities.ts'
import type { Zero3CapabilityDefinition, Zero3CapabilityHandler } from './contracts.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export class Zero3CapabilityTimeoutError extends Error {
  constructor() {
    super('PowerShell execution timed out.')
    this.name = 'Zero3CapabilityTimeoutError'
  }
}

function boundedTimeout(value: unknown): number {
  if (value == null) return DEFAULT_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}`)
  }
  return parsed
}

async function executePowerShell(
  commandText: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; cwd: string; shell: string }> {
  if (process.platform !== 'win32') throw new Error('shell.powershell.execute is only available on Windows Zero3 hosts')
  const snapshot = await probeShellCapabilities()
  const selected = snapshot.shells.find(shell => shell.status === 'ready' && (shell.kind === 'pwsh' || shell.kind === 'powershell'))
  if (!selected) throw new Error('Neither PowerShell 7 (pwsh) nor Windows PowerShell is available')
  const resolved = resolveWindowsCommand(selected.kind)
  const effectiveCwd = cwd?.trim() || process.cwd()
  const args = [...resolved.args, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', commandText]
  const started = Date.now()

  return await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, args, {
      cwd: effectiveCwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false

    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finishError(new Error('PowerShell output exceeded the 1 MiB per-stream limit'))
        return
      }
      target.push(Buffer.from(chunk))
    }
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }

    child.stdout.on('data', chunk => append(stdout, Buffer.from(chunk), 'stdout'))
    child.stderr.on('data', chunk => append(stderr, Buffer.from(chunk), 'stderr'))
    child.once('error', error => finishError(error))
    child.once('close', code => {
      if (settled) return
      settled = true
      cleanup()
      if (signal.aborted) return reject(Object.assign(new Error('PowerShell execution cancelled.'), { name: 'AbortError' }))
      if (timedOut) return reject(new Zero3CapabilityTimeoutError())
      resolve({
        exitCode: Number.isInteger(code) ? Number(code) : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        cwd: effectiveCwd,
        shell: selected.kind
      })
    })
  })
}

export function powerShellDefinition(nodeId: string, platform: NodeJS.Platform = process.platform): Zero3CapabilityDefinition {
  return {
    protocol: 'zero3.remote-capability.v1',
    id: 'shell.powershell.execute',
    version: '1.0',
    name: 'Execute PowerShell through local Zero3',
    description: 'Execute one PowerShell command on the local Zero3-managed Windows host after local policy authorization.',
    category: 'shell',
    status: platform === 'win32' ? 'available' : 'unavailable',
    executionMode: 'local',
    supportsStreaming: false,
    supportsCancellation: true,
    requiresApproval: 'policy',
    provider: 'zero3-local',
    nodeId,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 100000 },
        cwd: { type: 'string', maxLength: 8192 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS }
      },
      required: ['command'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' },
        durationMs: { type: 'integer' }, cwd: { type: 'string' }, shell: { type: 'string' }
      }
    }
  }
}

export const powerShellHandler: Zero3CapabilityHandler = async invocation => {
  const command = typeof invocation.input.command === 'string' ? invocation.input.command : ''
  if (!command.trim() || command.length > 100000) throw new Error('PowerShell command must contain 1..100000 characters')
  const cwd = typeof invocation.input.cwd === 'string' ? invocation.input.cwd : undefined
  return await executePowerShell(command, cwd, boundedTimeout(invocation.input.timeoutMs), invocation.signal)
}
