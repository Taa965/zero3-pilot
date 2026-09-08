import { useCallback, useEffect, useMemo, useState } from 'react'

import { LocalSessionAdapter } from '../adapters/LocalSessionAdapter'
import { ProjectAdapter, type Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { WebWorkspaceAdapter } from '../adapters/WebWorkspaceAdapter'
import { ChatGptProjectBindingDialog } from '../conversations/ChatGptProjectBindingDialog'
import { SessionProviderPickerDialog } from '../conversations/SessionProviderPickerDialog'
import type { LocalSessionRecord, WorkspaceProvider, WorkspaceSession } from '../conversations/session-types'
import { AppTitleBar } from './AppTitleBar'
import { GlobalRail } from './GlobalRail'
import { ContextPane } from './ContextPane'
import { WorkspaceRouter } from './WorkspaceRouter'
import { InspectorDrawer } from './InspectorDrawer'

export type ActiveModule = 'conversations' | 'tasks' | 'groups' | 'projects' | 'runtime'

const ACTIVE_PROJECT_STORAGE_KEY = 'zero3.active-project-id'

export function Zero3AppShell() {
  const [activeModule, setActiveModule] = useState<ActiveModule>('conversations')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [provider, setProvider] = useState<WorkspaceProvider>('gpt')
  const [webSessions, setWebSessions] = useState<WorkspaceSession[]>([])
  const [localSessions, setLocalSessions] = useState<LocalSessionRecord[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Zero3ProjectRecord[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [binding, setBinding] = useState<{ project: Zero3ProjectRecord; thenCreate: boolean } | null>(null)

  const sessions = useMemo<WorkspaceSession[]>(() => {
    const local = localSessions.map(LocalSessionAdapter.toWorkspaceSession)
    return [...webSessions, ...local]
  }, [webSessions, localSessions])

  const refreshWebSessions = useCallback(async () => {
    try {
      setWebSessions(await WebWorkspaceAdapter.list())
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const refreshLocalSessions = useCallback(() => {
    try {
      setLocalSessions(LocalSessionAdapter.list())
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
    void refreshWebSessions()
    return WebWorkspaceAdapter.subscribe(() => void refreshWebSessions())
  }, [refreshWebSessions])

  useEffect(() => {
    refreshLocalSessions()
    return LocalSessionAdapter.subscribe(refreshLocalSessions)
  }, [refreshLocalSessions])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    try {
      if (activeProjectId) window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId)
      else window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
    } catch {}
  }, [activeProjectId])

  const selectSession = useCallback((session: WorkspaceSession) => {
    setActiveSessionId(session.id)
    setProvider(session.provider)
  }, [])

  const deleteSession = useCallback(async (session: WorkspaceSession) => {
    try {
      if (session.source === 'local') {
        if (session.provider === 'antigravity') {
          const record = LocalSessionAdapter.get(session.id)
          if (record?.runtimeId) await window.zero3Antigravity.stop({ logicalSessionId: record.runtimeId }).catch(() => {})
        }
        LocalSessionAdapter.remove(session.id)
        refreshLocalSessions()
      } else {
        await WebWorkspaceAdapter.remove(session)
        await refreshWebSessions()
      }
      setActiveSessionId(current => (current === session.id ? null : current))
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshLocalSessions, refreshWebSessions])

  const selectProject = useCallback((project: Zero3ProjectRecord) => {
    setActiveProjectId(project.id)
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== project.id ? null : current
    })
  }, [sessions])

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
      await refreshWebSessions()
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshWebSessions])

  const createGptSession = useCallback(() => {
    const project = projects.find(item => item.id === activeProjectId) ?? null
    if (project && !project.chatGptProjectUrl) {
      setBinding({ project, thenCreate: true })
      return
    }
    void openGptSession(activeProjectId)
  }, [projects, activeProjectId, openGptSession])

  const createSession = useCallback(async (nextProvider: WorkspaceProvider, zero3ProfileId: string | null = null) => {
    setProviderPickerOpen(false)
    try {
      if (nextProvider === 'gpt') {
        createGptSession()
        return
      }
      if (nextProvider === 'gemini') {
        const id = await WebWorkspaceAdapter.createGeminiWeb(activeProjectId)
        setActiveSessionId(id)
        setProvider('gemini')
        await refreshWebSessions()
        return
      }
      const record = LocalSessionAdapter.create(nextProvider, activeProjectId, zero3ProfileId)
      refreshLocalSessions()
      setActiveSessionId(record.id)
      setProvider(nextProvider)
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [activeProjectId, createGptSession, refreshLocalSessions, refreshWebSessions])

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
      setProjectError(error instanceof Error ? error.messae : String(error))
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
  const activeLocalSession = activeSession?.source === 'local'
    ? localSessions.find(session => session.id === activeSession.id) ?? null
    : null
  const activeProject = projects.find(project => project.id === (activeProjectId ?? activeSession?.projectId)) ?? null
  const activeProjectSessionCount = useMemo(
    () => activeProjectId ? sessions.filter(session => session.projectId === activeProjectId).length : 0,
    [sessions, activeProjectId]
  )
  const nativeViewsMayShow = binding === null && !providerPickerOpen
  const workspaceSession = nativeViewsMayShow ? activeSession : null

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
          onCreateSession={() => setProviderPickerOpen(true)}
          onDeleteSession={session => void deleteSession(session)}
          onSelectProjectScope={selectProjectScope}
          onSelectProject={selectProject}
          onCreateProject={() => void createProject()}
        />
        <WorkspaceRouter
          activeModule={activeModule}
          provider={provider}
          onProviderChange={setProvider}
          activeSession={workspaceSession}
          activeLocalSession={activeLocalSession}
          activeProject={activeProject}
          activeProjectSessionCount={activeProjectSessionCount}
          onLocalSessionChanged={refreshLocalSessions}
          onBindChatGptProject={rebindProject}
          onUnbindChatGptProject={project => void unbindProject(project)}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
        />
        {inspectorOpen && <InspectorDrawer onClose={() => setInspectorOpen(false)} />}
      </div>

      {providerPickerOpen && (
        <SessionProviderPickerDialog
          project={activeProject}
          onCreate={(nextProvider, zero3ProfileId) => void createSession(nextProvider, zero3ProfileId ?? null)}
          onCancel={() => setProviderPickerOpen(false)}
        />
      )}

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
