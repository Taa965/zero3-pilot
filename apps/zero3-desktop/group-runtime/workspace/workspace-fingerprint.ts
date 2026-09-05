import { createHash } from 'node:crypto'

import type { GitStatusEntry } from './git-workspace.ts'

export interface WorkspaceFingerprintInput {
  branch: string
  headSha: string
  baseSha: string
  changedPaths: readonly string[]
  status: readonly GitStatusEntry[]
}

export function workspaceFingerprint(input: WorkspaceFingerprintInput): string {
  const normalized = {
    branch: input.branch.trim(),
    headSha: input.headSha.toLowerCase(),
    baseSha: input.baseSha.toLowerCase(),
    changedPaths: [...new Set(input.changedPaths.map(path => path.replaceAll('\\', '/')))].sort(),
    status: [...input.status]
      .map(entry => ({ status: entry.status, path: entry.path.replaceAll('\\', '/') }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status))
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
