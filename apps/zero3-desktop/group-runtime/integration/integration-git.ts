import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHA_RE = /^[0-9a-f]{40}$/i

export interface IntegrationMergeResult {
  status: 'merged' | 'conflict'
  headSha: string
  detail?: string
}

export interface IntegrationGitPort {
  currentBranch(): Promise<string>
  currentHead(): Promise<string>
  branchHead(branch: string): Promise<string>
  statusClean(): Promise<boolean>
  merge(branch: string): Promise<IntegrationMergeResult>
  resetTo(sha: string): Promise<void>
}

function safeBranch(branch: string): string {
  const value = branch.trim()
  if (!value || value.startsWith('-') || /[\0\r\n]/u.test(value)) throw new Error('unsafe branch')
  return value
}

function exactSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error('expected exact Git SHA')
  return sha
}

export class IntegrationGitAdapter implements IntegrationGitPort {
  constructor(readonly repoRoot: string) {}

  private async git(args: readonly string[], allow: readonly number[] = [0]) {
    try {
      const result = await execFileAsync('git', [...args], { cwd: this.repoRoot, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      const code = typeof failure.code === 'number' ? failure.code : -1
      if (allow.includes(code)) return { code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
      throw new Error(`git ${args[0] ?? ''} failed (${code}): ${(failure.stderr ?? failure.message).trim()}`)
    }
  }

  async currentBranch(): Promise<string> { return (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() }
  async currentHead(): Promise<string> { return exactSha((await this.git(['rev-parse', '--verify', 'HEAD'])).stdout.trim()) }
  async branchHead(branch: string): Promise<string> { return exactSha((await this.git(['rev-parse', '--verify', `refs/heads/${safeBranch(branch)}`])).stdout.trim()) }
  async statusClean(): Promise<boolean> { return (await this.git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.length === 0 }

  async merge(branch: string): Promise<IntegrationMergeResult> {
    const result = await this.git(['merge', '--no-ff', '--no-edit', safeBranch(branch)], [0, 1])
    if (result.code === 0) return { status: 'merged', headSha: await this.currentHead() }
    const detail = (result.stderr || result.stdout).trim()
    const abort = await this.git(['merge', '--abort'], [0, 1, 128])
    if (abort.code !== 0 && !(await this.statusClean())) throw new Error(`merge conflict and abort failed: ${detail}`)
    return { status: 'conflict', headSha: await this.currentHead(), detail }
  }

  async resetTo(sha: string): Promise<void> {
    await this.git(['reset', '--hard', exactSha(sha)])
  }
}
