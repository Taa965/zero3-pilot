import type { WorkspaceSession } from './session-types'

type SessionProject = Pick<WorkspaceSession, 'projectId'>

export function resolveCreateProjectId(
  activeProjectId: string | null,
  focusedProjectId: string | null,
  activeSession: SessionProject | null
): string | null {
  return activeProjectId ?? focusedProjectId ?? activeSession?.projectId ?? null
}
