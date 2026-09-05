import type { DevelopmentSessionDefinition } from '../contracts/index.ts'

export type PathAuthority = 'owned' | 'read_only' | 'forbidden' | 'unowned' | 'exception'

export interface PathAuthorityRecord {
  path: string
  authority: PathAuthority
  matchedPattern?: string
}

export interface OwnershipAudit {
  valid: boolean
  records: readonly PathAuthorityRecord[]
  violations: readonly PathAuthorityRecord[]
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern)
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]
    if (char === '*' && next === '*') {
      const after = normalized[index + 2]
      if (after === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegex(char)
    }
  }
  source += '$'
  return new RegExp(source, 'u')
}

function firstMatch(path: string, patterns: readonly string[]): string | undefined {
  const normalized = normalizePath(path)
  return patterns.find(pattern => globToRegExp(pattern).test(normalized))
}

export function classifyChangedPath(
  path: string,
  session: Pick<DevelopmentSessionDefinition, 'ownedPaths' | 'readOnlyPaths' | 'forbiddenPaths'>,
  integrationExceptions: readonly string[] = []
): PathAuthorityRecord {
  const normalized = normalizePath(path)
  const exception = firstMatch(normalized, integrationExceptions)
  if (exception) return { path: normalized, authority: 'exception', matchedPattern: exception }
  const forbidden = firstMatch(normalized, session.forbiddenPaths)
  if (forbidden) return { path: normalized, authority: 'forbidden', matchedPattern: forbidden }
  const readOnly = firstMatch(normalized, session.readOnlyPaths)
  if (readOnly) return { path: normalized, authority: 'read_only', matchedPattern: readOnly }
  const owned = firstMatch(normalized, session.ownedPaths)
  if (owned) return { path: normalized, authority: 'owned', matchedPattern: owned }
  return { path: normalized, authority: 'unowned' }
}

export function auditChangedPathOwnership(
  changedPaths: readonly string[],
  session: Pick<DevelopmentSessionDefinition, 'ownedPaths' | 'readOnlyPaths' | 'forbiddenPaths'>,
  integrationExceptions: readonly string[] = []
): OwnershipAudit {
  const records = [...new Set(changedPaths.map(normalizePath).filter(Boolean))]
    .sort()
    .map(path => classifyChangedPath(path, session, integrationExceptions))
  const violations = records.filter(record => !['owned', 'exception'].includes(record.authority))
  return { valid: violations.length === 0, records, violations }
}
