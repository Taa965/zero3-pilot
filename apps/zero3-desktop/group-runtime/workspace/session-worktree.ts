import { isAbsolute, resolve } from 'node:path'

import type { DevelopmentGroupDefinition, DevelopmentSessionDefinition } from '../contracts/index.ts'

export function resolveSessionWorktree(
  group: Pick<DevelopmentGroupDefinition, 'repository' | 'groupId'>,
  session: DevelopmentSessionDefinition
): DevelopmentSessionDefinition {
  if (session.groupId !== group.groupId) throw new Error('Development Session worktree group identity mismatch')
  const repositoryRoot = resolve(group.repository)
  const worktree = isAbsolute(session.worktree) ? resolve(session.worktree) : resolve(repositoryRoot, session.worktree)
  return worktree === session.worktree ? session : { ...session, worktree }
}
