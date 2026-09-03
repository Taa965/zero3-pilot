import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { captureWorkspaceState } from '../../executor-runtime/handoff/handoff-builder.ts'

const execFileAsync = promisify(execFile)
const SHA_RE = /^[0-9a-f]{40}$/i

export interface GitStatusEntry {
  status: string
  path: string
}

export interface GitWorkspacePort {
  resolveHead(): Promise<string>
  currentBranch(): Promise<string>
  branchHead(branch: string): Promise<string>
  isAncestor(baseSha: string, headSha: string): Promise<boolean>
  changedPaths(baseSha: string, headSha: string): Promise<readonly string[]>
  status(): Promise<readonly GitStatusEntry[]>
  handoffDirtyWorktreeFingerprint?(): Promise<string>
}

function assertSha(value: string, name: string): string {
  if (!SHA_RE.test(value)) throw new Error(`${name} must be an exact 40-character Git SHA`)
  return value
}

function assertBranch(value: string): string {
  const branch = value.trim()
  if (!branch || branch.startsWith('-') || /[\0\r\n]/u.test(branch)) throw new Error('branch is invalid')
  return branch
}

function parseNulList(text: string): string[] {
  return text.split('\0').map(value => value.trim()).filter(Boolean)
}

export class GitWorkspaceAdapter implements GitWorkspacePort {
  constructor(readonly repoRoot: string) {}

  private async git(args: readonly string[], allowExitCodes: readonly number[] = [0]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await execFileAsync('git', [...args], {
        cwd: this.repoRoot,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        shell: false
      })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
      const exitCode = typeof failure.code === 'number' ? failure.code : -1
      if (allowExitCodes.includes(exitCode)) return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode }
      throw new Error(`git ${args[0] ?? ''} failed (${exitCode}): ${(failure.stderr ?? failure.message).trim()}`)
    }
  }

  async resolveHead(): Promise<string> {
    const sha = (await this.git(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    return assertSha(sha, 'HEAD')
  }

  async currentBranch(): Promise<string> {
    const branch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
    return assertBranch(branch)
  }

  async branchHead(branch: string): Promise<string> {
    const sha = (await this.git(['rev-parse', '--verify', `refs/heads/${assertBranch(branch)}`])).stdout.trim()
    return assertSha(sha, 'branch head')
  }

  async isAncestor(baseSha: string, headSha: string): Promise<boolean> {
    const result = await this.git(['merge-base', '--is-ancestor', assertSha(baseSha, 'baseSha'), assertSha(headSha, 'headSha')], [0, 1])
    return result.exitCode === 0
  }

  async changedPaths(baseSha: string, headSha: string): Promise<readonly string[]> {
    const result = await this.git(['diff', '--name-only', '-z', `${assertSha(baseSha, 'baseSha')}..${assertSha(headSha, 'headSha')}`])
    return [...new Set(parseNulList(result.stdout).map(path => path.replaceAll('\\', '/')))].sort()
  }

  async status(): Promise<readonly GitStatusEntry[]> {
    const result = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const tokens = result.stdout.split('\0').filter(Boolean)
    const entries: GitStatusEntry[] = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      const status = token.slice(0, 2)
      let path = token.slice(3)
      if ((status.startsWith('R') || status.startsWith('C')) && index + 1 < tokens.length) {
        path = tokens[index + 1]
        index += 1
      }
      entries.push({ status, path: path.replaceAll('\\', '/') })
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path))
  }

  async handoffDirtyWorktreeFingerprint(): Promise<string> {
    return (await captureWorkspaceState(this.repoRoot)).dirtyWorktreeFingerprint
  }

  async createSessionWorktree(worktreePath: string, branch: string, baselineSha: string): Promise<void> {
    if (!worktreePath.trim() || /[\0\r\n]/u.test(worktreePath)) throw new Error('worktree path is invalid')
    await this.git(['worktree', 'add', '-b', assertBranch(branch), worktreePath, assertSha(baselineSha, 'baselineSha')])
  }

  async removeSessionWorktree(worktreePath: string): Promise<void> {
    if (!worktreePath.trim() || /[\0\r\n]/u.test(worktreePath)) throw new Error('worktree path is invalid')
    await this.git(['worktree', 'remove', worktreePath])
  }
}
