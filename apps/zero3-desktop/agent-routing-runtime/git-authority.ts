import path from 'node:path'

export type Zero3CodexCommandExecutor = {
  execCommand(params: unknown, timeoutMs?: number): Promise<unknown>
}

export type Zero3GitEvidence = {
  repositoryRoot: string
  gitDir: string
  commonGitDir: string
  linkedWorktree: boolean
  headSha: string
  baseSha: string | null
  branch: string | null
  clean: boolean
  changedFiles: string[]
  committedChangedFiles: string[]
  workingTreeChangedFiles: string[]
}

const COMMAND_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const OUTPUT_CAP = 256 * 1024

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstLine(value: string, label: string): string {
  const text = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!text) throw new Error(`${label} returned no output`)
  return text
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

async function git(executor: Zero3CodexCommandExecutor, cwd: string, args: string[], label: string): Promise<string> {
  let response: unknown
  try {
    response = await executor.execCommand({
      command: ['git', ...args],
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      outputBytesCap: OUTPUT_CAP,
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    }, REQUEST_TIMEOUT_MS)
  } catch (error) {
    throw new Error(`${label} could not be proven through pinned Codex command/exec: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = record(response)
  const exitCode = Number(root.exitCode)
  const stdout = typeof root.stdout === 'string' ? root.stdout : ''
  const stderr = typeof root.stderr === 'string' ? root.stderr : ''
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    throw new Error(`${label} failed: ${(stderr || stdout || `exit=${exitCode}`).trim().slice(0, 4000)}`)
  }
  return stdout
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function resolveGitPath(workspace: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(workspace, value))
}

function sameFilesystemPath(leftValue: string, rightValue: string): boolean {
  const left = path.normalize(leftValue)
  const right = path.normalize(rightValue)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export async function zero3GitEvidence(
  executor: Zero3CodexCommandExecutor,
  workspaceValue: string,
  requestedBaseSha?: string | null
): Promise<Zero3GitEvidence> {
  const workspace = path.resolve(workspaceValue)
  const repositoryRoot = path.resolve(firstLine(await git(executor, workspace, ['rev-parse', '--show-toplevel'], 'Git repository-root check'), 'repository root'))
  if (!inside(repositoryRoot, workspace)) throw new Error('task workspace is outside the Git repository reported by Codex')

  const gitDir = resolveGitPath(workspace, firstLine(await git(executor, workspace, ['rev-parse', '--git-dir'], 'Git directory check'), 'Git directory'))
  const commonGitDir = resolveGitPath(workspace, firstLine(await git(executor, workspace, ['rev-parse', '--git-common-dir'], 'Git common-directory check'), 'Git common directory'))
  const linkedWorktree = !sameFilesystemPath(gitDir, commonGitDir)

  const headSha = firstLine(await git(executor, workspace, ['rev-parse', '--verify', 'HEAD'], 'Git HEAD check'), 'HEAD')
  let baseSha: string | null = null
  if (requestedBaseSha?.trim()) {
    if (requestedBaseSha.trim().startsWith('-')) throw new Error('base SHA/ref must not start with a dash')
    baseSha = firstLine(
      await git(executor, workspace, ['rev-parse', '--verify', '--end-of-options', `${requestedBaseSha.trim()}^{commit}`], 'Git base check'),
      'base commit'
    )
  }

  const branchRaw = await git(executor, workspace, ['branch', '--show-current'], 'Git branch check')
  const branch = branchRaw.trim() || null
  const porcelain = await git(executor, workspace, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Git worktree check')
  const workingTreeChangedFiles = unique(
    porcelain
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.slice(3).trim())
      .filter(Boolean)
  )

  let committedChangedFiles: string[] = []
  if (baseSha && baseSha.toLowerCase() !== headSha.toLowerCase()) {
    const changed = await git(
      executor,
      workspace,
      ['diff', '--name-only', '--diff-filter=ACMRTUXB', '--no-renames', `${baseSha}..${headSha}`],
      'Git committed changed-files check'
    )
    committedChangedFiles = unique(lines(changed))
  }

  const changedFiles = unique([...committedChangedFiles, ...workingTreeChangedFiles])
  return {
    repositoryRoot,
    gitDir,
    commonGitDir,
    linkedWorktree,
    headSha,
    baseSha,
    branch,
    clean: workingTreeChangedFiles.length === 0,
    changedFiles,
    committedChangedFiles,
    workingTreeChangedFiles
  }
}

export function assertZero3GitPreflight(
  evidence: Zero3GitEvidence,
  requestedBaseSha?: string | null,
  requireLinkedWorktree = false
): void {
  if (requireLinkedWorktree && !evidence.linkedWorktree) {
    throw new Error('writable agent tasks require an isolated linked Git worktree; the primary working tree is not accepted')
  }
  if (requestedBaseSha?.trim() && evidence.baseSha && evidence.headSha.toLowerCase() !== evidence.baseSha.toLowerCase()) {
    throw new Error(`task workspace HEAD ${evidence.headSha} does not match requested base ${evidence.baseSha}`)
  }
  if (!evidence.clean) {
    throw new Error(`task worktree must start clean; changed files: ${evidence.workingTreeChangedFiles.join(', ')}`)
  }
}
