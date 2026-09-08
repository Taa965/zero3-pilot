import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type {
  ExecutorShellCapability,
  ExecutorShellCapabilitySnapshot,
  ExecutorShellKind
} from '../executor-types.ts'
import { resolveWindowsCommand, type ResolvedCommand } from '../external/windows-command.ts'

const execFileAsync = promisify(execFile)

export type ShellCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>

export interface ShellCapabilityProbeOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  run?: ShellCommandRunner
  resolveCommand?: (command: string) => ResolvedCommand
}

interface ShellCandidate {
  kind: ExecutorShellKind
  command: string
  args: readonly string[]
}

const WINDOWS_CANDIDATES: readonly ShellCandidate[] = [
  {
    kind: 'pwsh',
    command: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
  },
  {
    kind: 'powershell',
    command: 'powershell',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
  },
  { kind: 'cmd', command: 'cmd', args: ['/d', '/c', 'ver'] },
  { kind: 'wsl', command: 'wsl', args: ['--version'] }
]

const POSIX_CANDIDATES: readonly ShellCandidate[] = [
  {
    kind: 'pwsh',
    command: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
  },
  { kind: 'bash', command: 'bash', args: ['--version'] },
  { kind: 'sh', command: 'sh', args: ['--version'] }
]

function firstUsefulLine(stdout: string, stderr: string): string | undefined {
  return `${stdout}\n${stderr}`
    .replaceAll('\u0000', '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean)
}

function normalizedVersion(kind: ExecutorShellKind, stdout: string, stderr: string): string | undefined {
  if (kind === 'wsl') return undefined
  const line = firstUsefulLine(stdout, stderr)
  if (!line) return undefined
  if (kind === 'cmd') return /\[Version\s+([^\]]+)\]/iu.exec(line)?.[1] ?? line
  if (kind === 'bash' || kind === 'sh') return line.replace(/^GNU bash,\s*version\s*/iu, '')
  return line
}

async function defaultRun(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024
  })
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  }
}

async function probeCandidate(
  candidate: ShellCandidate,
  timeoutMs: number,
  run: ShellCommandRunner,
  resolveCommand: (command: string) => ResolvedCommand
): Promise<ExecutorShellCapability> {
  const resolved = resolveCommand(candidate.command)
  try {
    const result = await run(resolved.command, [...resolved.args, ...candidate.args], timeoutMs)
    return {
      kind: candidate.kind,
      command: candidate.command,
      resolvedCommand: resolved.command !== candidate.command ? resolved.command : undefined,
      status: 'ready',
      version: normalizedVersion(candidate.kind, result.stdout, result.stderr)
    }
  } catch {
    return {
      kind: candidate.kind,
      command: candidate.command,
      resolvedCommand: resolved.command !== candidate.command ? resolved.command : undefined,
      status: 'unavailable'
    }
  }
}

export async function probeShellCapabilities(
  options: ShellCapabilityProbeOptions = {}
): Promise<ExecutorShellCapabilitySnapshot> {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 2_500
  const run = options.run ?? defaultRun
  const resolveCommand = options.resolveCommand ?? resolveWindowsCommand
  const candidates = platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_CANDIDATES

  const shells = await Promise.all(
    candidates.map(candidate => probeCandidate(candidate, timeoutMs, run, resolveCommand))
  )

  const preferred = shells.find(shell => shell.status === 'ready')?.kind
  return {
    policy: 'codex-native',
    ...(preferred ? { preferred } : {}),
    shells
  }
}