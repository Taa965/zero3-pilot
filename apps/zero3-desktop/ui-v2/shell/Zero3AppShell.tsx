import { useCallback, useEffect, useMemo, useState } from 'react'

import { ProjectAdapter, type Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { WebWorkspaceAdapter, type WebSession } from '../adapters/WebWorkspaceAdapter'
import { ChatGptProjectBindingDialog } from '../conversations/ChatGptProjectBindingDialog'
import { AppTitleBar } from './AppTitleBar'
import { GlobalRail } from './GlobalRail'
import { ContextPane } from './ContextPane'
import { WorkspaceRouter } from './WorkspaceRouter'
import { InspectorDrawer } from './InspectorDrawer'

export type ActiveModule = 'conversations' | 'tasks' | 'groups' | 'projects' | 'runtime'
export type WorkspaceProvider = 'codex' | 'gpt' | 'gemini'

const ACTIVE_PROJECT_STORAGE_KEY = 'zero3.active-project-id'

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
  // Set while the ChatGPT-project picker is open. It holds the Zero3 project
  // whose binding is being decided, plus whether a session should be created
  // once that is settled -- the same dialog serves "new session in an unbound
  // project" and "change the binding from the project view".
  const [binding, setBinding] = useState<{ project: Zero3ProjectRecord; thenCreate: boolean } | null>(null)

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
      setActiveProjectId(current => {
        const stored = (() => {
          try {
            return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)?.trim() || null
          } catch {
            return null
          }
        })()
        const candidate = current ?? stored
        return candidate && next.some(project => project.id === candidate) ? candidate : (next[0]?.id ?? null)
      })
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

  useEffect(() => {
    try {
      if (activeProjectId) window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId)
      else window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
    } catch {}
  }, [activeProjectId])

  const selectSession = useCallback((session: WebSession) => {
    setActiveSessionId(session.id)
    setProvider(session.provider)
  }, [])

  const selectProject = useCallback((project: Zero3ProjectRecord) => {
    setActiveProjectId(project.id)
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== project.id ? null : current
    })
  }, [sessions])

  // Scope changes come from the switcher in the session pane. Clearing the scope
  // keeps the current session selected -- the unscoped view lists it too, so
  // there is nothing to deselect.
  const selectProjectScope = useCallback((projectId: string | null) => {
    setActiveProjectId(projectId)
    if (projectId === null) return
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== projectId ? null : current
    })
  }, [sessions])

  const openGptSession = useCallback(async (projectId: string | null) => {
    try {
      const id = await WebWorkspaceAdapter.createGptWeb(projectId)
      setActiveSessionId(id)
      setProvider('gpt')
      await refreshSessions()
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshSessions])

  // A scoped project that has never been bound gets the question once: which
  // ChatGPT project do its conversations belong to? Every session after that
  // inherits the answer, and an unscoped session never asks.
  const createGptSession = useCallback(() => {
    const project = projects.find(item => item.id === activeProjectId) ?? null
    if (project && !project.chatGptProjectUrl) {
      setBinding({ project, thenCreate: true })
      return
    }
    void openGptSession(activeProjectId)
  }, [projects, activeProjectId, openGptSession])

  const applyBinding = useCallback(async (chatGptProjectUrl: string | null) => {
    if (!binding) return
    const { project, thenCreate } = binding
    setBinding(null)
    try {
      const updated = await ProjectAdapter.update({ id: project.id, chatGptProjectUrl })
      setProjects(current => current.map(item => (item.id === updated.id ? updated : item)))
      setProjectError(null)
      if (thenCreate) await openGptSession(updated.id)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    }
  }, [binding, openGptSession])

  const skipBinding = useCallback(() => {
    if (!binding) return
    const { project, thenCreate } = binding
    setBinding(null)
    if (thenCreate) void openGptSession(project.id)
  }, [binding, openGptSession])

  const rebindProject = useCallback((project: Zero3ProjectRecord) => {
    setBinding({ project, thenCreate: false })
  }, [])

  const unbindProject = useCallback(async (project: Zero3ProjectRecord) => {
    try {
      const updated = await ProjectAdapter.update({ id: project.id, chatGptProjectUrl: null })
      setProjects(current => current.map(item => (item.id === updated.id ? updated : item)))
      setProjectError(null)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    }
  }, [])

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
          onCreateGptSession={createGptSession}
          onSelectProjectScope={selectProjectScope}
          onSelectProject={selectProject}
          onCreateProject={() => void createProject()}
        />
        <WorkspaceRouter
          activeModule={activeModule}
          provider={provider}
          onProviderChange={setProvider}
          // The ChatGPT page is a native view stacked above the renderer, so it
          // would cover the picker. Dropping the id unmounts the surface, which
          // hides that view for as long as the dialog is up.
          activeSessionId={binding === null && activeSession?.provider === 'gpt' ? activeSession.id : null}
          activeProject={activeProject}
          activeProjectSessionCount={activeProjectSessionCount}
          onBindChatGptProject={rebindProject}
          onUnbindChatGptProject={project => void unbindProject(project)}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
        />
        {inspectorOpen && <InspectorDrawer onClose={() => setInspectorOpen(false)} />}
      </div>
      {binding && (
        <ChatGptProjectBindingDialog
          projectName={binding.project.name}
          boundUrl={binding.project.chatGptProjectUrl}
          onBind={url => void applyBinding(url)}
          onSkip={skipBinding}
          onCancel={() => setBinding(null)}
        />
      )}
    </div>
  )
}
