import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'

import { checkpointHash, sha256Text } from './handoff-hash.ts'
import {
  ZERO3_HANDOFF_SCHEMA,
  type HandoffBuildInput,
  type HandoffChangedFile,
  type HandoffUntrackedFile,
  type Zero3HandoffCheckpointV1
} from './handoff-types.ts'

const execFile = promisify(execFileCallback)
const MAX_DIFF_BYTES = 4 * 1024 * 1024

async function git(workspace: string, args: readonly string[], maxBuffer = MAX_DIFF_BYTES): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer
  })
  return stdout
}

function nonEmpty(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must be non-empty`)
  return normalized
}

function parsePorcelain(status: string): { changed: HandoffChangedFile[]; untrackedPaths: string[] } {
  const records = status.split('\0').filter(Boolean)
  const changed: HandoffChangedFile[] = []
  const untrackedPaths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4 || record[2] !== ' ') throw new Error('unexpected git status --porcelain record')
    const code = record.slice(0, 2)
    const file = record.slice(3)
    if (code === '??') {
      untrackedPaths.push(file)
      continue
    }
    changed.push({ path: file, status: code })
    if (code.includes('R') || code.includes('C')) {
      const destination = records[++index]
      if (!destination) throw new Error('rename/copy status record is incomplete')
      changed.push({ path: destination, status: `${code}:destination` })
    }
  }
  return { changed, untrackedPaths }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function captureUntracked(workspace: string, paths: readonly string[]): Promise<HandoffUntrackedFile[]> {
  const result: HandoffUntrackedFile[] = []
  for (const relative of [...paths].sort()) {
    const absolute = path.resolve(workspace, relative)
    const root = path.resolve(workspace) + path.sep
    if (!absolute.startsWith(root)) throw new Error(`untracked path escapes workspace: ${relative}`)
    const metadata = await stat(absolute)
    if (!metadata.isFile()) throw new Error(`untracked entry is not a regular file: ${relative}`)
    result.push({ path: relative, byte_len: metadata.size, sha256: await hashFile(absolute) })
  }
  return result
}

export async function captureWorkspaceState(workspace: string): Promise<{
  workspace: string
  branch: string
  headSha: string
  dirtyWorktreeFingerprint: string
  changedFiles: HandoffChangedFile[]
  untrackedFiles: HandoffUntrackedFile[]
  workingDiff: string
}> {
  const prefix = (await git(workspace, ['rev-parse', '--show-prefix'])).trim()
  if (prefix) throw new Error('handoff workspace must be the repository root')
  const branch = nonEmpty('branch', await git(workspace, ['branch', '--show-current']))
  const headSha = nonEmpty('HEAD', await git(workspace, ['rev-parse', 'HEAD']))
  const porcelain = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const { changed, untrackedPaths } = parsePorcelain(porcelain)
  const untrackedFiles = await captureUntracked(workspace, untrackedPaths)
  const workingDiff = await git(workspace, ['diff', '--binary', 'HEAD'])
  const dirtyWorktreeFingerprint = sha256Text(JSON.stringify({ porcelain, workingDiff, untrackedFiles }))
  return {
    workspace: path.resolve(workspace),
    branch,
    headSha,
    dirtyWorktreeFingerprint,
    changedFiles: changed.sort((a, b) => a.path.localeCompare(b.path)),
    untrackedFiles,
    workingDiff
  }
}

export async function buildHandoffCheckpoint(input: HandoffBuildInput): Promise<Zero3HandoffCheckpointV1> {
  if (!Number.isSafeInteger(input.previousGeneration) || input.previousGeneration < 0) {
    throw new Error('previousGeneration must be a non-negative safe integer')
  }
  const state = await captureWorkspaceState(input.workspace)
  const unsigned: Omit<Zero3HandoffCheckpointV1, 'checkpoint_hash'> = {
    schema_version: ZERO3_HANDOFF_SCHEMA,
    task_id: nonEmpty('task_id', input.taskId),
    execution_id: nonEmpty('execution_id', input.executionId),
    workspace: state.workspace,
    repo_id: nonEmpty('repo_id', input.repoId),
    branch: state.branch,
    base_sha: nonEmpty('base_sha', input.baseSha),
    head_sha: state.headSha,
    dirty_worktree_fingerprint: state.dirtyWorktreeFingerprint,
    changed_files: state.changedFiles,
    untracked_files: state.untrackedFiles,
    working_diff: state.workingDiff,
    objective: nonEmpty('objective', input.objective),
    constraints: [...input.constraints],
    acceptance_criteria: [...input.acceptanceCriteria],
    completed: [...input.completed],
    in_progress: [...input.inProgress],
    remaining: [...input.remaining],
    tests_run: [...input.testsRun],
    test_results: input.testResults.map(result => ({ ...result })),
    pending_approvals: input.pendingApprovals.map(approval => ({ ...approval })),
    last_executor: nonEmpty('last_executor', input.lastExecutor),
    last_session_id: nonEmpty('last_session_id', input.lastSessionId),
    stop_reason: nonEmpty('stop_reason', input.stopReason),
    next_action: nonEmpty('next_action', input.nextAction),
    handoff_generation: input.previousGeneration + 1,
    created_at: input.createdAt ?? new Date().toISOString()
  }
  return { ...unsigned, checkpoint_hash: checkpointHash(unsigned) }
}
