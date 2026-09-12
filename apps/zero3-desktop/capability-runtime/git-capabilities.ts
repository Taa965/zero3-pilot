import type { Zero3CapabilityDefinition, Zero3CapabilityHandler } from './contracts.ts'
import {
  assertGitBranchName,
  assertGitPathspecs,
  assertGitRef,
  literalPathspecs,
  MAX_GIT_OUTPUT_BYTES,
  parseGitLogRecords,
  parseGitStatusPorcelainZ,
  Zero3GitError,
  Zero3GitRuntime,
  type Zero3GitRunOptions
} from './git-runtime.ts'

const MAX_DIFF_BYTES = 1024 * 1024
const MAX_LOG_LIMIT = 100
const DEFAULT_LOG_LIMIT = 20
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const LOG_FORMAT = '%H\u001f%h\u001f%an\u001f%aI\u001f%s\u001e'

export type Zero3GitCapabilitiesOptions = {
  nodeId: string
  roots: readonly string[]
  cwd?: string
}

type RegisteredCapability = { definition: Zero3CapabilityDefinition; handler: Zero3CapabilityHandler }

function text(value: unknown, label: string, minLength: number, maxLength: number): string {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length < minLength) throw new Zero3GitError('INVALID_INPUT', `${label} must contain at least ${minLength} characters`)
  if (raw.length > maxLength) throw new Zero3GitError('INVALID_INPUT', `${label} must contain at most ${maxLength} characters`)
  if (/\0/u.test(raw)) throw new Zero3GitError('INVALID_INPUT', `${label} contains a NUL byte`)
  return raw
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Zero3GitError('INVALID_INPUT', `${label} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function assertRemote(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : 'origin'
  if (!REMOTE_RE.test(raw)) throw new Zero3GitError('INVALID_INPUT', 'remote is not a valid Git remote name')
  return raw
}

function definition(
  nodeId: string,
  id: string,
  name: string,
  description: string,
  supportsCancellation: boolean,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>
): Zero3CapabilityDefinition {
  return {
    protocol: 'zero3.remote-capability.v1',
    id,
    version: '1.0',
    name,
    description,
    category: 'git',
    status: 'available',
    executionMode: 'local',
    supportsStreaming: false,
    supportsCancellation,
    requiresApproval: 'policy',
    provider: 'zero3-local',
    nodeId,
    inputSchema,
    outputSchema
  }
}

const WORKSPACE_INPUT = { type: 'string', minLength: 1, maxLength: 32768 }
const PATHSPEC_INPUT = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, maxItems: 500 }

/**
 * Structured Git capabilities, each mapped to exactly one reviewed Git
 * invocation. There is no generic git.exec: the capability id *is* the
 * authorization unit, which is what lets local policy stay meaningful.
 */
export function createZero3GitCapabilities(options: Zero3GitCapabilitiesOptions): RegisteredCapability[] {
  const runtime = new Zero3GitRuntime(options.roots, options.cwd ?? process.cwd())

  const stagedPaths = async (workspace: string, run: Zero3GitRunOptions): Promise<string[]> => {
    const result =
      (await runtime.tryRun(workspace, ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD'], run)) ??
      (await runtime.tryRun(workspace, ['diff', '--cached', '--name-only', '-z', '--no-renames'], run))
    if (!result) return []
    return [...new Set(result.stdout.split('\0').filter(Boolean).map(item => item.replaceAll('\\', '/')))]
  }

  const currentBranch = async (workspace: string, run: Zero3GitRunOptions): Promise<string | null> => {
    const result = await runtime.tryRun(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD'], run)
    const branch = result?.stdout.trim() ?? ''
    return branch || null
  }

  const statusHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    await runtime.assertRepository(workspace, invocation.signal)
    const run: Zero3GitRunOptions = { signal: invocation.signal }

    const head = (await runtime.tryRun(workspace, ['rev-parse', '--verify', 'HEAD'], run))?.stdout.trim() ?? null
    const branch = await currentBranch(workspace, run)
    const upstream = (await runtime.tryRun(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], run))?.stdout.trim() ?? null

    let ahead = 0
    let behind = 0
    if (upstream) {
      const counts = await runtime.tryRun(workspace, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], run)
      const parts = (counts?.stdout ?? '').trim().split(/\s+/u)
      if (parts.length === 2 && parts.every(part => /^\d+$/u.test(part))) {
        ahead = Number(parts[0])
        behind = Number(parts[1])
      }
    }

    const porcelain = await runtime.run(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], run)
    const parsed = parseGitStatusPorcelainZ(porcelain.stdout)
    const clean = parsed.staged.length === 0 && parsed.unstaged.length === 0 && parsed.untracked.length === 0 && parsed.conflicted.length === 0
    return { workspace, branch, head, upstream, ahead, behind, clean, ...parsed }
  }

  const diffHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const scope = typeof invocation.input.scope === 'string' ? invocation.input.scope : 'working'
    const pathspecs = invocation.input.pathspec == null ? [] : assertGitPathspecs(invocation.input.pathspec, 'pathspec')
    const maxBytes = integer(invocation.input.maxBytes, MAX_DIFF_BYTES, 1024, MAX_DIFF_BYTES, 'maxBytes')
    const run: Zero3GitRunOptions = { signal: invocation.signal, maxBytes }

    const prefix = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    let base: string | null = null
    if (scope === 'staged') prefix.splice(1, 0, '--cached')
    else if (scope === 'commit') {
      base = assertGitRef(invocation.input.base, 'base')
      prefix.push(base, 'HEAD')
    } else if (scope !== 'working') {
      throw new Zero3GitError('INVALID_INPUT', `scope must be one of working, staged, commit (received ${scope})`)
    }

    const specs = literalPathspecs(pathspecs)
    try {
      const result = await runtime.run(workspace, [...prefix, '--', ...specs], run)
      return {
        workspace, scope, base, pathspecs, maxBytes, truncated: false,
        bytes: Buffer.byteLength(result.stdout, 'utf8'), content: result.stdout
      }
    } catch (error) {
      if (error instanceof Zero3GitError && error.code === 'GIT_OUTPUT_TOO_LARGE') {
        // A 100 MB diff must never ride the MCP response. Fall back to a bounded
        // stat summary so the caller still learns which files changed.
        const summary = await runtime.run(workspace, [...prefix, '--stat', '--', ...specs], {
          signal: invocation.signal,
          maxBytes: 256 * 1024
        })
        return { workspace, scope, base, pathspecs, maxBytes, truncated: true, bytes: null, content: null, summary: summary.stdout }
      }
      throw error
    }
  }

  const logHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const limit = integer(invocation.input.limit, DEFAULT_LOG_LIMIT, 1, MAX_LOG_LIMIT, 'limit')
    const ref = invocation.input.ref == null ? 'HEAD' : assertGitRef(invocation.input.ref, 'ref')
    const result = await runtime.tryRun(workspace, ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, ref, '--'], { signal: invocation.signal })
    if (!result) return { workspace, ref, limit, commits: [], empty: true }
    return { workspace, ref, limit, commits: parseGitLogRecords(result.stdout), empty: false }
  }

  const showHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const ref = assertGitRef(invocation.input.ref, 'ref')
    const pathSpec = invocation.input.path == null ? [] : assertGitPathspecs([invocation.input.path], 'path')
    const maxBytes = integer(invocation.input.maxBytes, MAX_DIFF_BYTES, 1024, MAX_DIFF_BYTES, 'maxBytes')
    const args = ['show', '--no-color', '--no-ext-diff', '--format=fuller', '--stat', ref]
    if (pathSpec.length > 0) args.push('--', ...literalPathspecs(pathSpec))
    try {
      const result = await runtime.run(workspace, args, { signal: invocation.signal, maxBytes })
      return { workspace, ref, path: pathSpec[0] ?? null, maxBytes, truncated: false, content: result.stdout }
    } catch (error) {
      if (error instanceof Zero3GitError && error.code === 'GIT_OUTPUT_TOO_LARGE') {
        return { workspace, ref, path: pathSpec[0] ?? null, maxBytes, truncated: true, content: null }
      }
      throw error
    }
  }

  const addHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    // Explicit paths only. `git add -A`, `git add .` and a bare `git add` are
    // never constructed, so an invocation can only stage what it named.
    const paths = assertGitPathspecs(invocation.input.paths, 'paths')
    const run: Zero3GitRunOptions = { signal: invocation.signal }
    await runtime.run(workspace, ['add', '--', ...literalPathspecs(paths)], run)
    return { workspace, requested: paths, staged: await stagedPaths(workspace, run) }
  }

  const commitHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const message = text(invocation.input.message, 'message', 1, 2000)
    const owned = assertGitPathspecs(invocation.input.paths, 'paths')
    const run: Zero3GitRunOptions = { signal: invocation.signal }

    const staged = await stagedPaths(workspace, run)
    if (staged.length === 0) throw new Zero3GitError('NOTHING_STAGED', 'the Git index has no staged changes to commit')
    // Another session may have staged its own work into this index. Committing
    // that would attribute someone else's change to this task, so refuse.
    const undeclared = staged.filter(file => !owned.some(entry => file === entry || file.startsWith(entry.endsWith('/') ? entry : `${entry}/`)))
    if (undeclared.length > 0) {
      throw new Zero3GitError(
        'UNRELATED_STAGED_CHANGES',
        `refusing to commit paths that were not declared by this invocation: ${undeclared.join(', ')}`
      )
    }

    await runtime.run(workspace, ['commit', '-m', message], run)
    const sha = (await runtime.run(workspace, ['rev-parse', 'HEAD'], run)).stdout.trim()
    return { workspace, sha, message, branch: await currentBranch(workspace, run), committed: staged }
  }

  const fetchHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const remote = assertRemote(invocation.input.remote)
    const ref = invocation.input.ref == null ? null : assertGitRef(invocation.input.ref, 'ref')
    const run: Zero3GitRunOptions = { signal: invocation.signal, timeoutMs: 300_000 }
    const branch = await currentBranch(workspace, run)
    const tracking = branch ? `refs/remotes/${remote}/${branch}` : null
    const before = tracking ? (await runtime.tryRun(workspace, ['rev-parse', '--verify', tracking], run))?.stdout.trim() ?? null : null

    // fetch only: never pull, merge or reset. Those change the working tree and
    // belong to a decision the caller has to make explicitly.
    const result = await runtime.run(workspace, ['fetch', '--no-tags', remote, ...(ref ? [ref] : [])], run)
    const after = tracking ? (await runtime.tryRun(workspace, ['rev-parse', '--verify', tracking], run))?.stdout.trim() ?? null : null
    return {
      workspace, remote, ref, branch, before, after, changed: before !== after,
      output: result.stderr.trim().split('\n').filter(Boolean).slice(-20)
    }
  }

  const pushHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const remote = assertRemote(invocation.input.remote)
    const run: Zero3GitRunOptions = { signal: invocation.signal, timeoutMs: 300_000 }
    const branch = invocation.input.branch == null
      ? await currentBranch(workspace, run)
      : assertGitBranchName(invocation.input.branch, 'branch')
    if (!branch) throw new Zero3GitError('DETACHED_HEAD', 'cannot push a detached HEAD without an explicit branch')

    const tracking = `refs/remotes/${remote}/${branch}`
    const before = (await runtime.tryRun(workspace, ['rev-parse', '--verify', tracking], run))?.stdout.trim() ?? null
    try {
      // Explicit refspec, no `+`, no --force and no --force-with-lease anywhere
      // in this runtime: a diverged remote is a failure the caller must resolve.
      await runtime.run(workspace, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/non-fast-forward|rejected|fetch first|stale info/iu.test(message)) {
        throw new Zero3GitError('PUSH_REJECTED', `remote ${remote}/${branch} diverged; Zero3 never force-pushes, resolve it explicitly: ${message}`)
      }
      throw error
    }
    const after = (await runtime.tryRun(workspace, ['rev-parse', '--verify', tracking], run))?.stdout.trim() ?? null
    return { workspace, remote, branch, before, after, pushed: true, force: false }
  }

  const branchHandler: Zero3CapabilityHandler = async invocation => {
    const workspace = await runtime.resolveWorkspace(invocation.input.workspace)
    const action = typeof invocation.input.action === 'string' ? invocation.input.action : 'list'
    const run: Zero3GitRunOptions = { signal: invocation.signal }
    const current = await currentBranch(workspace, run)

    if (action === 'current') return { workspace, action, current, branches: [] }

    if (action === 'list') {
      const result = await runtime.tryRun(
        workspace,
        ['for-each-ref', 'refs/heads', '--format=%(refname:short) %(objectname:short) %(upstream:short)'],
        run
      )
      const branches = (result?.stdout ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [name, sha, upstream] = line.split(/\s+/u)
          return { name: name ?? '', sha: sha ?? '', upstream: upstream ?? null, current: name === current }
        })
        .filter(item => item.name)
      return { workspace, action, current, branches }
    }

    if (action === 'create') {
      const name = assertGitBranchName(invocation.input.name, 'name')
      const startPoint = invocation.input.startPoint == null ? null : assertGitRef(invocation.input.startPoint, 'startPoint')
      // Switching branches is a separate decision and a separate capability; this
      // only creates the ref and fails closed on a dirty conflict like Git does.
      await runtime.run(workspace, ['branch', name, ...(startPoint ? [startPoint] : [])], run)
      const sha = (await runtime.run(workspace, ['rev-parse', '--verify', `refs/heads/${name}`], run)).stdout.trim()
      return { workspace, action, current, name, startPoint, sha, created: true }
    }

    throw new Zero3GitError('INVALID_INPUT', `action must be one of list, current, create (received ${action})`)
  }

  return [
    {
      definition: definition(
        options.nodeId, 'git.status', 'Read local Zero3 Git status',
        'Return structured branch, ahead/behind and staged/unstaged/untracked/conflicted entries for a local Zero3 repository.',
        false,
        { type: 'object', properties: { workspace: WORKSPACE_INPUT }, required: ['workspace'], additionalProperties: false },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, branch: { type: ['string', 'null'] }, head: { type: ['string', 'null'] },
            upstream: { type: ['string', 'null'] }, ahead: { type: 'integer' }, behind: { type: 'integer' }, clean: { type: 'boolean' },
            staged: { type: 'array', items: { type: 'object' } }, unstaged: { type: 'array', items: { type: 'object' } },
            untracked: { type: 'array', items: { type: 'string' } }, conflicted: { type: 'array', items: { type: 'string' } }
          }
        }
      ),
      handler: statusHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.diff', 'Read a bounded local Zero3 Git diff',
        'Return a bounded diff for the working tree, the index, or a commit range. Oversized diffs return a stat summary instead of the patch.',
        true,
        {
          type: 'object',
          properties: {
            workspace: WORKSPACE_INPUT,
            scope: { enum: ['working', 'staged', 'commit'] },
            base: { type: 'string' },
            pathspec: PATHSPEC_INPUT,
            maxBytes: { type: 'integer', minimum: 1024, maximum: MAX_DIFF_BYTES }
          },
          required: ['workspace'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, scope: { type: 'string' }, base: { type: ['string', 'null'] },
            pathspecs: { type: 'array', items: { type: 'string' } }, maxBytes: { type: 'integer' },
            truncated: { type: 'boolean' }, bytes: { type: ['integer', 'null'] },
            content: { type: ['string', 'null'] }, summary: { type: 'string' }
          }
        }
      ),
      handler: diffHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.log', 'Read bounded local Zero3 Git history',
        'Return at most 100 commits of local Zero3 Git history with sha, author, date and subject.',
        false,
        {
          type: 'object',
          properties: {
            workspace: WORKSPACE_INPUT,
            limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT },
            ref: { type: 'string' }
          },
          required: ['workspace'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, ref: { type: 'string' }, limit: { type: 'integer' }, empty: { type: 'boolean' },
            commits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sha: { type: 'string' }, shortSha: { type: 'string' }, author: { type: 'string' },
                  date: { type: 'string' }, subject: { type: 'string' }
                }
              }
            }
          }
        }
      ),
      handler: logHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.show', 'Show one local Zero3 Git object',
        'Return a bounded `git show` for one ref, optionally limited to a single repository-relative path.',
        true,
        {
          type: 'object',
          properties: {
            workspace: WORKSPACE_INPUT, ref: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1024, maximum: MAX_DIFF_BYTES }
          },
          required: ['workspace', 'ref'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, ref: { type: 'string' }, path: { type: ['string', 'null'] },
            maxBytes: { type: 'integer' }, truncated: { type: 'boolean' }, content: { type: ['string', 'null'] }
          }
        }
      ),
      handler: showHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.add', 'Stage explicit paths in a local Zero3 repository',
        'Stage exactly the repository-relative paths named by the caller. There is no -A, no dot pathspec and no implicit repository-wide staging.',
        false,
        {
          type: 'object',
          properties: { workspace: WORKSPACE_INPUT, paths: PATHSPEC_INPUT },
          required: ['workspace', 'paths'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, requested: { type: 'array', items: { type: 'string' } },
            staged: { type: 'array', items: { type: 'string' } }
          }
        }
      ),
      handler: addHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.commit', 'Commit declared staged paths in a local Zero3 repository',
        'Commit the current index only when every staged path was declared by this invocation; unrelated staged work fails closed.',
        true,
        {
          type: 'object',
          properties: {
            workspace: WORKSPACE_INPUT,
            message: { type: 'string', minLength: 1, maxLength: 2000 },
            paths: PATHSPEC_INPUT
          },
          required: ['workspace', 'message', 'paths'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, sha: { type: 'string' }, message: { type: 'string' },
            branch: { type: ['string', 'null'] }, committed: { type: 'array', items: { type: 'string' } }
          }
        }
      ),
      handler: commitHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.fetch', 'Fetch a remote into a local Zero3 repository',
        'Fetch refs from a remote into a local Zero3 repository. Fetch never pulls, merges or resets the working tree.',
        true,
        {
          type: 'object',
          properties: { workspace: WORKSPACE_INPUT, remote: { type: 'string' }, ref: { type: 'string' } },
          required: ['workspace'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, remote: { type: 'string' }, ref: { type: ['string', 'null'] },
            branch: { type: ['string', 'null'] }, before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] },
            changed: { type: 'boolean' }, output: { type: 'array', items: { type: 'string' } }
          }
        }
      ),
      handler: fetchHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.push', 'Push a local Zero3 branch to a remote',
        'Push one local branch to a remote with an explicit refspec. Force push and force-with-lease do not exist in this runtime.',
        true,
        {
          type: 'object',
          properties: { workspace: WORKSPACE_INPUT, remote: { type: 'string' }, branch: { type: 'string' } },
          required: ['workspace'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' },
            before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] },
            pushed: { type: 'boolean' }, force: { type: 'boolean' }
          }
        }
      ),
      handler: pushHandler
    },
    {
      definition: definition(
        options.nodeId, 'git.branch', 'Inspect or create local Zero3 Git branches',
        'List branches, report the current branch, or create a branch. Switching branches is intentionally not part of P1.',
        false,
        {
          type: 'object',
          properties: {
            workspace: WORKSPACE_INPUT,
            action: { enum: ['list', 'current', 'create'] },
            name: { type: 'string' },
            startPoint: { type: 'string' }
          },
          required: ['workspace'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            workspace: { type: 'string' }, action: { type: 'string' }, current: { type: ['string', 'null'] },
            name: { type: 'string' }, sha: { type: 'string' }, created: { type: 'boolean' },
            branches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, sha: { type: 'string' },
                  upstream: { type: ['string', 'null'] }, current: { type: 'boolean' }
                }
              }
            }
          }
        }
      ),
      handler: branchHandler
    }
  ]
}
