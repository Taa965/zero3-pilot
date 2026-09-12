import path from 'node:path'

import type {
  Zero3CapabilityDefinition,
  Zero3CapabilityPolicyDecision,
  Zero3CapabilityContext
} from './contracts.ts'
import { isInsideRoot, parseCapabilityAllowedRoots } from './path-safety.ts'

export type Zero3CapabilityPolicyRequest = {
  definition: Zero3CapabilityDefinition
  input: Record<string, unknown>
  context?: Zero3CapabilityContext
}

export interface Zero3CapabilityPolicyPort {
  authorize(request: Zero3CapabilityPolicyRequest): Promise<Zero3CapabilityPolicyDecision>
  summary(): { mode: string; allowedRootCount: number }
  /** Optional so existing P0 policy stubs keep compiling. */
  allowedRoots?(): readonly string[]
}

type EnvironmentLike = Record<string, string | undefined>

// Capabilities that only observe the host. `git.fetch` is deliberately absent:
// it writes refs into .git, so it is not a read.
const READ_ONLY_CAPABILITIES = new Set([
  'filesystem.list',
  'filesystem.stat',
  'filesystem.read',
  'git.status',
  'git.diff',
  'git.log',
  'git.show'
])

// Creating content inside an allow-listed root is the ordinary working mode of
// a coding agent. It stays allowed under project_scope, guarded by the path
// resolver rather than by a confirmation prompt.
const PROJECT_WRITE_CAPABILITIES = new Set([
  'filesystem.write',
  'filesystem.mkdir',
  'filesystem.copy'
])

// Destructive or history-moving operations need an explicit local approval.
const CONFIRMATION_CAPABILITIES = new Set([
  'filesystem.move',
  'filesystem.delete',
  'git.add',
  'git.commit',
  'git.fetch',
  'git.push'
])

const PATH_INPUT_KEYS = ['path', 'from', 'to', 'workspace'] as const

function readOnlyBranchAction(input: Record<string, unknown>): boolean {
  const action = typeof input.action === 'string' ? input.action : 'list'
  return action === 'list' || action === 'current'
}

export class EnvironmentZero3CapabilityPolicy implements Zero3CapabilityPolicyPort {
  private readonly mode: string
  private readonly allowedRootsList: string[]
  private readonly baseCwd: string

  constructor(private readonly env: EnvironmentLike = process.env) {
    this.mode = (env.ZERO3_CAPABILITY_POLICY_MODE ?? 'project_scope').trim().toLowerCase()
    this.allowedRootsList = parseCapabilityAllowedRoots(env)
    this.baseCwd = env.ZERO3_CODEX_CWD ? path.resolve(env.ZERO3_CODEX_CWD) : process.cwd()
  }

  summary(): { mode: string; allowedRootCount: number } {
    return { mode: this.mode, allowedRootCount: this.allowedRootsList.length }
  }

  allowedRoots(): readonly string[] {
    return [...this.allowedRootsList]
  }

  private insideAllowedRoots(candidate: string): boolean {
    const absolute = path.resolve(this.baseCwd, candidate)
    return this.allowedRootsList.some(root => isInsideRoot(root, absolute))
  }

  /**
   * Policy is a second, independent containment gate. Even if a handler were
   * wrong, a request naming a path outside the allow-listed roots is refused
   * before the handler is ever scheduled.
   */
  private allInputsInsideRoots(input: Record<string, unknown>): boolean {
    for (const key of PATH_INPUT_KEYS) {
      const value = input[key]
      if (typeof value === 'string' && value.trim()) {
        if (!this.insideAllowedRoots(value.trim())) return false
      }
    }
    return true
  }

  async authorize(request: Zero3CapabilityPolicyRequest): Promise<Zero3CapabilityPolicyDecision> {
    const id = request.definition.id
    if (id === 'system.status') return { decision: 'allow', reason: 'local status is read-only' }

    if (this.mode === 'disabled') {
      return { decision: 'deny', reason: 'capability policy mode disabled does not permit execution' }
    }
    if (this.mode === 'full_control') {
      // full_control still cannot escape the structured capability set: there is
      // no filesystem.exec and no git.exec for it to reach.
      return { decision: 'allow', reason: 'operator enabled full_control locally' }
    }

    if (this.mode === 'read_only') {
      if (READ_ONLY_CAPABILITIES.has(id)) {
        return { decision: 'allow', reason: 'read_only mode permits local read capabilities' }
      }
      if (id === 'git.branch' && readOnlyBranchAction(request.input)) {
        return { decision: 'allow', reason: 'read_only mode permits branch inspection' }
      }
      return { decision: 'deny', reason: `capability policy mode read_only does not permit ${id}` }
    }

    if (this.mode !== 'project_scope') {
      return { decision: 'deny', reason: `capability policy mode ${this.mode} does not permit execution` }
    }

    if (id === 'shell.powershell.execute') {
      const requested = typeof request.input.cwd === 'string' && request.input.cwd.trim()
        ? path.resolve(request.input.cwd.trim())
        : this.baseCwd
      const allowed = this.allowedRootsList.some(root => isInsideRoot(root, requested))
      if (!allowed) return { decision: 'deny', reason: 'cwd is outside locally allow-listed Zero3 roots' }
      return {
        decision: 'require_confirmation',
        reason: 'PowerShell is not a filesystem sandbox; project_scope requires local approval for arbitrary commands'
      }
    }

    const insideRoots = this.allInputsInsideRoots(request.input)
    if (id === 'git.branch' && readOnlyBranchAction(request.input)) {
      if (!insideRoots) return { decision: 'deny', reason: 'requested path is outside locally allow-listed Zero3 roots' }
      return { decision: 'allow', reason: 'branch inspection is read-only' }
    }
    if (READ_ONLY_CAPABILITIES.has(id)) {
      if (!insideRoots) return { decision: 'deny', reason: 'requested path is outside locally allow-listed Zero3 roots' }
      return { decision: 'allow', reason: 'read capability inside an allow-listed Zero3 root' }
    }
    if (PROJECT_WRITE_CAPABILITIES.has(id)) {
      if (!insideRoots) return { decision: 'deny', reason: 'requested path is outside locally allow-listed Zero3 roots' }
      return { decision: 'allow', reason: 'write capability inside an allow-listed Zero3 root' }
    }
    if (CONFIRMATION_CAPABILITIES.has(id)) {
      if (!insideRoots) return { decision: 'deny', reason: 'requested path is outside locally allow-listed Zero3 roots' }
      return {
        decision: 'require_confirmation',
        reason: `${id} changes or moves content and requires local Zero3 approval under project_scope`
      }
    }
    if (id === 'git.branch') {
      if (!insideRoots) return { decision: 'deny', reason: 'requested path is outside locally allow-listed Zero3 roots' }
      return {
        decision: 'require_confirmation',
        reason: 'creating a branch mutates repository refs and requires local Zero3 approval under project_scope'
      }
    }
    return { decision: 'deny', reason: `capability ${id} has no local policy rule` }
  }
}
