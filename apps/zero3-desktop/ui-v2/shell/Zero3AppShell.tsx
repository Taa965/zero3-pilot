import { useCallback, useEffect, useMemo, useState } from 'react'

import { ProjectAdapter, type Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { WebWorkspaceAdapter, type WebSession } from '../adapters/WebWorkspaceAdapter'
import { AppTitleBar } from './AppTitleBar'
import { GlobalRail } from './GlobalRail'
import { ContextPane } from './ContextPane'
import { WorkspaceRouter } from './WorkspaceRouter'
import { InspectorDrawer } from './InspectorDrawer'

export type ActiveModule = 'conversations' | 'tasks' | 'groups' | 'projects' | 'runtime'
export type WorkspaceProvider = 'codex' | 'gpt' | 'gemini'

export function Zero3AppShell() {
  const [activeModule, setActiveModule] = useState<ActiveModule>('conversations')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [provider, setProvider] = useState<WorkspaceProvider>('codex')
  const [sessions, setSessions] = useState<WebSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Zero3ProjectRecord[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await WebWorkspaceAdapter.list())
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const next = await ProjectAdapter.list()
      setProjects(next)
      setActiveProjectId(current => current && next.some(project => project.id === current) ? current : (next[0]?.id ?? null))
      setProjectError(null)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    return WebWorkspaceAdapter.subscribe(() => void refreshSessions())
  }, [refreshSessions])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const selectSession = useCallback((session: WebSession) => {
    setActiveSessionId(session.id)
    setProvider(session.provider)
  }, [])

  const selectProject = useCallback((project: Zero3ProjectRecord) => {
    setActiveProjectId(project.id)
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== null && active.projectId !== project.id ? null : current
    })
  }, [sessions])

  const createGptSession = useCallback(async () => {
    try {
      const id = await WebWorkspaceAdapter.createGptWeb(activeProjectId)
      setActiveSessionId(id)
      setProvider('gpt')
      await refreshSessions()
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [activeProjectId, refreshSessions])

  const createProject = useCallback(async () => {
    try {
      const project = await ProjectAdapter.createFromDirectory()
      if (!project) return
      setProjects(current => [project, ...current.filter(item => item.id !== project.id)])
      setActiveProjectId(project.id)
      setProjectError(null)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? null
  const activeProject = projects.find(project => project.id === activeProjectId) ?? null
  const activeProjectSessionCount = useMemo(
    () => activeProjectId ? sessions.filter(session => session.projectId === activeProjectId).length : 0,
    [sessions, activeProjectId]
  )

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar />
      <div className="flex min-h-0 flex-1">
        <GlobalRail activeModule={activeModule} onModuleChange={setActiveModule} />
        <ContextPane
          activeModule={activeModule}
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeProjectId={activeProjectId}
          sessionError={sessionError}
          projects={projects}
          projectError={projectError}
          onSelectSession={selectSession}
          onCreateGptSession={() => void createGptSession()}
          onSelectProject={selectProject}
          onCreateProject={() => void createProject()}
        />
        <WorkspaceRouter
          activeModule={activeModule}
          provider={provider}
          onProviderChange={setProvider}
          activeSessionId={activeSession?.provider === 'gpt' ? activeSession.id : null}
          activeProject={activeProject}
          activeProjectSessionCount={activeProjectSessionCount}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
        />
        {inspectorOpen && <InspectorDrawer onClose={() => setInspectorOpen(false)} />}
      </div>
    </div>
  )
}
