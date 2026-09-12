import path from 'node:path'

import type {
  Zero3CapabilityDefinition,
  Zero3CapabilityPolicyDecision,
  Zero3CapabilityContext
} from './contracts.ts'

export type Zero3CapabilityPolicyRequest = {
  definition: Zero3CapabilityDefinition
  input: Record<string, unknown>
  context?: Zero3CapabilityContext
}

export interface Zero3CapabilityPolicyPort {
  authorize(request: Zero3CapabilityPolicyRequest): Promise<Zero3CapabilityPolicyDecision>
  summary(): { mode: string; allowedRootCount: number }
}

type EnvironmentLike = Record<string, string | undefined>

function parseRoots(env: EnvironmentLike): string[] {
  const raw = [env.ZERO3_CAPABILITY_ALLOWED_ROOTS, env.ZERO3_REMOTE_HOST_WORKSPACES, env.ZERO3_CODEX_CWD]
    .filter(Boolean)
    .join(';')
  const unique = new Map<string, string>()
  for (const item of raw.split(';').map(value => value.trim()).filter(Boolean)) {
    const resolved = path.resolve(item)
    unique.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved)
  }
  return [...unique.values()]
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class EnvironmentZero3CapabilityPolicy implements Zero3CapabilityPolicyPort {
  private readonly mode: string
  private readonly allowedRoots: string[]

  constructor(private readonly env: EnvironmentLike = process.env) {
    this.mode = (env.ZERO3_CAPABILITY_POLICY_MODE ?? 'project_scope').trim().toLowerCase()
    this.allowedRoots = parseRoots(env)
  }

  summary(): { mode: string; allowedRootCount: number } {
    return { mode: this.mode, allowedRootCount: this.allowedRoots.length }
  }

  async authorize(request: Zero3CapabilityPolicyRequest): Promise<Zero3CapabilityPolicyDecision> {
    if (request.definition.id === 'system.status') return { decision: 'allow', reason: 'local status is read-only' }
    if (this.mode === 'disabled' || this.mode === 'read_only') {
      return { decision: 'deny', reason: `capability policy mode ${this.mode} does not permit execution` }
    }
    if (this.mode === 'full_control') return { decision: 'allow', reason: 'operator enabled full_control locally' }
    if (request.definition.id === 'shell.powershell.execute') {
      const requested = typeof request.input.cwd === 'string' && request.input.cwd.trim()
        ? path.resolve(request.input.cwd.trim())
        : path.resolve(this.env.ZERO3_CODEX_CWD ?? process.cwd())
      const allowed = this.allowedRoots.some(root => inside(root, requested))
      if (!allowed) return { decision: 'deny', reason: 'cwd is outside locally allow-listed Zero3 roots' }
      return {
        decision: 'require_confirmation',
        reason: 'PowerShell is not a filesystem sandbox; project_scope requires local approval for arbitrary commands'
      }
    }
    return { decision: 'deny', reason: `capability ${request.definition.id} has no local policy rule` }
  }
}
