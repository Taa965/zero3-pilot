import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Zero3CapabilityPathError, Zero3CapabilityPathResolver } from './path-safety.ts'

// One Git authority for the capability surface. The remote host, the development
// group and this runtime all end up in the same place: an argument array handed
// to execFile with shell:false. There is deliberately no `git.exec`, no argv
// passthrough and no string interpolation of caller input.
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_GIT_TIMEOUT_MS = 120_000
export const MAX_GIT_TIMEOUT_MS = 600_000

const SHA_RE = /^[0-9a-f]{40}$/iu
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,255}$/u
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u

export type Zero3GitResult = { stdout: string; stderr: string; exitCode: number }

export type Zero3GitRunOptions = {
  signal?: AbortSignal
  allowExitCodes?: readonly number[]
  maxBytes?: number
  timeoutMs?: number
}

export class Zero3GitError extends Zero3CapabilityPathError {}

export function assertGitSha(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!SHA_RE.test(raw)) throw new Zero3GitError('INVALID_INPUT', `${label} must be an exact 40 character Git SHA`)
  return raw.toLowerCase()
}

/**
 * Refs are validated, not escaped. Rejecting a leading `-` is what stops a
 * caller turning `ref` into `--upload-pack=<command>` style argument injection.
 */
export function assertGitRef(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!REF_RE.test(raw)) throw new Zero3GitError('INVALID_INPUT', `${label} is not a safe Git ref`)
  return raw
}

export function assertGitBranchName(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!BRANCH_RE.test(raw) || raw.includes('..') || raw.includes('//') || raw.endsWith('/') || raw.endsWith('.lock') || raw.includes('@{')) {
    throw new Zero3GitError('INVALID_INPUT', `${label} is not a valid Git branch name`)
  }
  return raw
}

/**
 * Repository-relative paths only. Absolute paths, drive letters, traversal and
 * leading dashes are refused, then every path is passed as an explicit
 * `:(literal)` pathspec so no glob ever expands beyond what the caller named.
 *
 * `.` is refused together with `..`: `git add -- :(literal).` stages the entire
 * repository, which is exactly the repository-wide staging this capability is
 * not allowed to express.
 */
export function assertGitPathspecs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Zero3GitError('INVALID_INPUT', `${label} must be a non-empty array of repository-relative paths`)
  if (value.length > 500) throw new Zero3GitError('INVALID_INPUT', `${label} must contain at most 500 paths`)
  const normalized: string[] = []
  for (const item of value) {
    const raw = typeof item === 'string' ? item.trim().replaceAll('\\', '/') : ''
    if (!raw) throw new Zero3GitError('INVALID_INPUT', `${label} contains an empty path`)
    if (raw.length > 4096 || /[\0\r\n]/u.test(raw)) throw new Zero3GitError('INVALID_INPUT', `${label} contains an invalid path`)
    if (raw.startsWith('-') || raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw) || raw.split('/').includes('..')) {
      throw new Zero3GitError('INVALID_INPUT', `${label} contains an unsafe path: ${JSON.stringify(raw)}`)
    }
    if (raw.split('/').includes('.')) {
      throw new Zero3GitError('INVALID_INPUT', `${label} contains an unsafe path: ${JSON.stringify(raw)} (a dot segment would name the whole repository)`)
    }
    if (!normalized.includes(raw)) normalized.push(raw)
  }
  return normalized
}

export function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map(item => `:(literal)${item}`)
}

export function parseGitStatusPorcelainZ(stdout: string): {
  staged: Array<{ path: string; status: string }>
  unstaged: Array<{ path: string; status: string }>
  untracked: string[]
  conflicted: string[]
} {
  const staged: Array<{ path: string; status: string }> = []
  const unstaged: Array<{ path: string; status: string }> = []
  const untracked: string[] = []
  const conflicted: string[] = []
  const tokens = stdout.split('\0').filter(token => token.length > 0)

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token.length < 4) continue
    const indexStatus = token[0] as string
    const worktreeStatus = token[1] as string
    const file = token.slice(3).replaceAll('\\', '/')
    if ((indexStatus === 'R' || indexStatus === 'C') && index + 1 < tokens.length) index += 1

    if (indexStatus === '?' && worktreeStatus === '?') {
      untracked.push(file)
      continue
    }
    if (
      indexStatus === 'U' || worktreeStatus === 'U' ||
      (indexStatus === 'A' && worktreeStatus === 'A') ||
      (indexStatus === 'D' && worktreeStatus === 'D')
    ) {
      conflicted.push(file)
      continue
    }
    if (indexStatus !== ' ' && indexStatus !== '?') staged.push({ path: file, status: indexStatus })
    if (worktreeStatus !== ' ' && worktreeStatus !== '?') unstaged.push({ path: file, status: worktreeStatus })
  }

  const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path)
  return {
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    untracked: untracked.sort(),
    conflicted: conflicted.sort()
  }
}

export function parseGitLogRecords(stdout: string): Array<{ sha: string; shortSha: string; author: string; date: string; subject: string }> {
  const records: Array<{ sha: string; shortSha: string; author: string; date: string; subject: string }> = []
  for (const chunk of stdout.split('\u001e')) {
    const line = chunk.trim()
    if (!line) continue
    const fields = line.split('\u001f')
    if (fields.length < 5) continue
    records.push({
      sha: (fields[0] as string).trim(),
      shortSha: (fields[1] as string).trim(),
      author: (fields[2] as string).trim(),
      date: (fields[3] as string).trim(),
      subject: (fields[4] as string).trim()
    })
  }
  return records
}

export class Zero3GitRuntime {
  private readonly resolver: Zero3CapabilityPathResolver

  constructor(roots: readonly string[], cwd: string = process.cwd()) {
    this.resolver = new Zero3CapabilityPathResolver(roots, cwd)
  }

  async resolveWorkspace(value: unknown): Promise<string> {
    const resolved = await this.resolver.resolve(value, { label: 'workspace', mustExist: true })
    const stats = await fs.promises.stat(resolved.absolute)
    if (!stats.isDirectory()) throw new Zero3GitError('NOT_A_DIRECTORY', 'workspace is not a directory')
    return resolved.absolute
  }

  private execute(workspace: string, args: readonly string[], options: Zero3GitRunOptions): Promise<Zero3GitResult> {
    const maxBytes = options.maxBytes ?? MAX_GIT_OUTPUT_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...args],
        {
          cwd: workspace,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: maxBytes,
          shell: false,
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: timeoutMs,
          // Never let a capability hang on an interactive credential or pager
          // prompt: fail loudly instead of blocking the operation forever.
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_PAGER: 'cat',
            GIT_OPTIONAL_LOCKS: '0'
          }
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 })
            return
          }
          const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }
          if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR') {
            reject(Object.assign(new Error('Git execution cancelled.'), { name: 'AbortError' }))
            return
          }
          if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new Zero3GitError('GIT_OUTPUT_TOO_LARGE', `git ${args[0] ?? ''} produced more than ${maxBytes} bytes of output`))
            return
          }
          if (failure.killed && failure.signal) {
            reject(new Zero3GitError('GIT_TIMEOUT', `git ${args[0] ?? ''} exceeded the ${timeoutMs} ms limit`))
            return
          }
          if (failure.code === 'ENOENT') {
            reject(new Zero3GitError('GIT_UNAVAILABLE', 'the git executable was not found on the local Zero3 host'))
            return
          }
          const exitCode = typeof failure.code === 'number' ? failure.code : -1
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode
          })
        }
      )
    })
  }

  async run(workspace: string, args: readonly string[], options: Zero3GitRunOptions = {}): Promise<Zero3GitResult> {
    const result = await this.execute(workspace, args, options)
    const allowed = options.allowExitCodes ?? [0]
    if (!allowed.includes(result.exitCode)) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 8).join('\n')
      throw new Zero3GitError('GIT_COMMAND_FAILED', `git ${args[0] ?? ''} failed with exit code ${result.exitCode}: ${detail}`)
    }
    return result
  }

  /** Best effort probe: a non-zero exit is data, not a failure (empty repos, no upstream). */
  async tryRun(workspace: string, args: readonly string[], options: Zero3GitRunOptions = {}): Promise<Zero3GitResult | null> {
    const result = await this.execute(workspace, args, options)
    return result.exitCode === 0 ? result : null
  }

  async assertRepository(workspace: string, signal?: AbortSignal): Promise<string> {
    const result = await this.tryRun(workspace, ['rev-parse', '--show-toplevel'], { signal })
    if (!result) throw new Zero3GitError('NOT_A_REPOSITORY', 'workspace is not inside a Git working tree')
    return result.stdout.trim() || workspace
  }
}
