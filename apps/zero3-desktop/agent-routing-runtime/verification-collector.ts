import type { Zero3ExecutionResultV2, Zero3TaskSpecV2, Zero3VerificationResult } from './agent-contracts'
import type { Zero3CodexCommandExecutor } from './git-authority'

type JsonRecord = Record<string, unknown>

const MAX_CHECKS = 32
const MAX_ARGV = 32
const MAX_ARG = 4096
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 128 * 1024

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown, label: string, max = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}

function command(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARGV) throw new Error(`${label} must contain 1..${MAX_ARGV} argv items`)
  return value.map((entry, index) => text(entry, `${label}[${index}]`, MAX_ARG))
}

function diagnostic(stdout: string, stderr: string): string {
  const body = (stdout || stderr || '').trim()
  return body.length <= 16_000 ? body : `${body.slice(0, 15_997)}...`
}

export class Zero3VerificationCollector {
  constructor(private readonly executor: Zero3CodexCommandExecutor) {}

  async collect(task: Zero3TaskSpecV2, _candidate: Zero3ExecutionResultV2): Promise<Zero3VerificationResult[]> {
    if (task.verification.length > MAX_CHECKS) throw new Error(`TaskSpec verification may contain at most ${MAX_CHECKS} checks`)
    if (task.verification.length === 0) return []
    if (!task.worktreePath?.trim()) {
      return task.verification.map((spec, index) => ({
        id: typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim() : `verification-${index + 1}`,
        state: 'BLOCKED',
        reason: 'verification requires an explicit task worktreePath'
      }))
    }

    const results: Zero3VerificationResult[] = []
    for (let index = 0; index < task.verification.length; index += 1) {
      const spec = record(task.verification[index])
      let id: string
      let argv: string[]
      let timeoutMs: number
      try {
        id = text(spec.id ?? `verification-${index + 1}`, `verification[${index}].id`, 256)
        argv = command(spec.command, `verification[${index}].command`)
        timeoutMs = spec.timeoutMs == null ? 60_000 : Number(spec.timeoutMs)
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
          throw new Error(`verification[${index}].timeoutMs must be 1000..${MAX_TIMEOUT_MS}`)
        }
      } catch (error) {
        results.push({
          id: typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim().slice(0, 256) : `verification-${index + 1}`,
          state: 'BLOCKED',
          reason: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      try {
        const response = record(await this.executor.execCommand({
          command: argv,
          cwd: task.worktreePath,
          timeoutMs,
          outputBytesCap: MAX_OUTPUT,
          sandboxPolicy: { type: 'readOnly', networkAccess: false }
        }, timeoutMs + 5_000))
        const exitCode = Number(response.exitCode)
        const stdout = typeof response.stdout === 'string' ? response.stdout : ''
        const stderr = typeof response.stderr === 'string' ? response.stderr : ''
        if (!Number.isInteger(exitCode)) {
          results.push({ id, state: 'BLOCKED', command: argv.join(' '), reason: 'Codex command/exec returned an invalid exit code' })
          continue
        }
        const detail = diagnostic(stdout, stderr)
        results.push(exitCode === 0
          ? { id, state: 'PASSED', command: argv.join(' '), evidence: `Codex command/exec exit=0${detail ? `\n${detail}` : ''}` }
          : { id, state: 'FAILED', command: argv.join(' '), evidence: `Codex command/exec exit=${exitCode}${detail ? `\n${detail}` : ''}`, reason: `verification command exited ${exitCode}` })
      } catch (error) {
        results.push({
          id,
          state: 'BLOCKED',
          command: argv.join(' '),
          reason: `verification could not be proven through Codex command/exec: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
    return results
  }
}
