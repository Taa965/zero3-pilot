import { globToRegExp } from '../workspace/ownership.ts'

export function normalizePlanningPathScope(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+/, '').replace(/\/+$/u, '')
}

function hasGlob(value: string): boolean {
  return /[*?]/u.test(value)
}

function staticPrefix(value: string): string {
  const normalized = normalizePlanningPathScope(value)
  const wildcard = normalized.search(/[*?]/u)
  if (wildcard < 0) return normalized
  return normalized.slice(0, wildcard).replace(/\/+$/u, '')
}

function prefixContains(left: string, right: string): boolean {
  if (!left || !right) return !left || !right
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export function planningPathScopesMayOverlap(left: string, right: string): boolean {
  const a = normalizePlanningPathScope(left)
  const b = normalizePlanningPathScope(right)
  if (!a || !b) return false
  if (a === b) return true

  const aGlob = hasGlob(a)
  const bGlob = hasGlob(b)
  if (!aGlob && !bGlob) return false
  if (!aGlob) return globToRegExp(b).test(a)
  if (!bGlob) return globToRegExp(a).test(b)

  const aPrefix = staticPrefix(a)
  const bPrefix = staticPrefix(b)
  if (!aPrefix || !bPrefix) return true
  return prefixContains(aPrefix, bPrefix)
}

export function planningScopeOverlapScore(existing: ReadonlySet<string>, candidates: readonly string[]): number {
  let score = 0
  for (const candidate of candidates) {
    for (const current of existing) {
      if (planningPathScopesMayOverlap(current, candidate)) {
        score += current === candidate ? 2 : 1
        break
      }
    }
  }
  return score
}
