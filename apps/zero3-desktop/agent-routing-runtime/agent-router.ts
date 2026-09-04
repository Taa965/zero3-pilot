import type { Zero3AgentTarget, Zero3TaskSpecV2, Zero3TaskType } from './agent-contracts'

export type Zero3ProviderAvailability = {
  codex: { available: boolean; authenticated: boolean }
  gemini: { available: boolean; authenticated: boolean }
}

export type Zero3RouteDecision = {
  target: Exclude<Zero3AgentTarget, 'AUTO'>
  reason: string
  fallbackAllowed: boolean
}

const GEMINI_PREFERRED = new Set<Zero3TaskType>(['DESIGN', 'RESEARCH', 'REVIEW'])
const CODEX_PREFERRED = new Set<Zero3TaskType>(['IMPLEMENT', 'VERIFY', 'FIX', 'INTEGRATE'])

function available(target: 'CODEX' | 'GEMINI', availability: Zero3ProviderAvailability) {
  const state = target === 'CODEX' ? availability.codex : availability.gemini
  return state.available && state.authenticated
}

export function validateTaskSpecV2(task: Zero3TaskSpecV2): void {
  if (task.protocol !== 'zero3.pilot.task-spec.v2') throw new Error('unsupported TaskSpec protocol')
  for (const [label, value, max] of [
    ['taskId', task.taskId, 128], ['executionId', task.executionId, 128], ['projectId', task.projectId, 256],
    ['title', task.title, 512], ['goal', task.goal, 64_000], ['createdBySessionId', task.createdBySessionId, 256]
  ] as const) {
    if (!value?.trim() || value.trim().length > max) throw new Error(`${label} is invalid`)
  }
  if (!Number.isSafeInteger(task.contextVersion) || task.contextVersion < 1) throw new Error('contextVersion must be a positive integer')
  if (task.reviewPolicy.maxCycles != null && (!Number.isInteger(task.reviewPolicy.maxCycles) || task.reviewPolicy.maxCycles < 1 || task.reviewPolicy.maxCycles > 20)) {
    throw new Error('reviewPolicy.maxCycles must be 1..20')
  }
  if (task.worktreePath && !task.worktreePath.trim()) throw new Error('worktreePath must be null or non-empty')
}

export class Zero3AgentRouter {
  resolve(task: Zero3TaskSpecV2, availability: Zero3ProviderAvailability): Zero3RouteDecision {
    validateTaskSpecV2(task)

    if (task.target !== 'AUTO') {
      if (!available(task.target, availability)) {
        throw new Error(`Target ${task.target} is unavailable or unauthenticated; explicit targets are never silently changed`)
      }
      return { target: task.target, reason: 'explicit user/task target', fallbackAllowed: false }
    }

    const preferred: 'CODEX' | 'GEMINI' = GEMINI_PREFERRED.has(task.type)
      ? 'GEMINI'
      : CODEX_PREFERRED.has(task.type)
        ? 'CODEX'
        : 'CODEX'
    if (available(preferred, availability)) {
      return { target: preferred, reason: `AUTO policy prefers ${preferred} for task type ${task.type}`, fallbackAllowed: true }
    }
    const alternate = preferred === 'CODEX' ? 'GEMINI' : 'CODEX'
    if (available(alternate, availability)) {
      return { target: alternate, reason: `${preferred} unavailable; AUTO fallback to ${alternate}`, fallbackAllowed: true }
    }
    throw new Error('No eligible authenticated provider is available for AUTO routing')
  }
}
