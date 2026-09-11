import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { LocalSessionAdapter } from '../adapters/LocalSessionAdapter'
import { ProjectAdapter, type Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { ProjectLinkAdapter } from '../adapters/ProjectLinkAdapter'
import { ProjectLinkDialog } from '../projects/ProjectLinkDialog'
import { SessionArchiveAdapter } from '../adapters/SessionArchiveAdapter'
import { WebWorkspaceAdapter, type WebSessionExecutionStatus } from '../adapters/WebWorkspaceAdapter'
import { ChatGptProjectBindingDialog } from '../conversations/ChatGptProjectBindingDialog'
import { hideNativeWebSession } from '../conversations/native-overlay-visibility'
import { RenameSessionDialog } from '../conversations/RenameSessionDialog'
import { SessionProviderPickerDialog } from '../conversations/SessionProviderPickerDialog'
import { resolveCreateProjectId } from '../conversations/session-create-target'
import type { LocalSessionRecord, LocalSessionRuntimeConfig, WorkspaceProvider, WorkspaceSession } from '../conversations/session-types'
import { AppTitleBar } from './AppTitleBar'
import { GlobalRail } from './GlobalRail'
import { ContextPane } from './ContextPane'
import { WorkspaceRouter } from './WorkspaceRouter'
import { InspectorDrawer } from './InspectorDrawer'
import type { RuntimeTarget } from '../runtime/runtime-types'
import { TaskProvider } from '../tasks/TaskContext'

export type ActiveModule = 'conversations' | 'tasks' | 'groups' | 'projects' | 'skills' | 'runtime'

const ACTIVE_PROJECT_STORAGE_KEY = 'zero3.active-project-id'
const SESSION_COMPLETION_UNREAD_STORAGE_KEY = 'zero3.session-completion-unread.v1'
const MAX_COMPLETION_UNREAD_SESSIONS = 500

function readCompletionUnreadSessionIds(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_COMPLETION_UNREAD_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return new Set()
    const ids = parsed.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    return new Set(ids.slice(-MAX_COMPLETION_UNREAD_SESSIONS))
  } catch {
    return new Set()
  }
}

function persistCompletionUnreadSessionIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(
      SESSION_COMPLETION_UNREAD_STORAGE_KEY,
      JSON.stringify([...ids].slice(-MAX_COMPLETION_UNREAD_SESSIONS))
    )
  } catch {}
}


export function Zero3AppShell() {
  const [activeModule, setActiveModule] = useState<ActiveModule>('conversations')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [runtimeTarget, setRuntimeTarget] = useState<RuntimeTarget>('kernel')
  const [provider, setProvider] = useState<WorkspaceProvider>('gpt')
  const [webSessions, setWebSessions] = useState<WorkspaceSession[]>([])
  const [localSessions, setLocalSessions] = useState<LocalSessionRecord[]>([])
  const [executingLocalSessionIds, setExecutingLocalSessionIds] = useState<Set<string>>(() => new Set())
  const [completionUnreadSessionIds, setCompletionUnreadSessionIds] = useState<Set<string>>(readCompletionUnreadSessionIds)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const viewedSessionIdRef = useRef<string | null>(null)
  const localExecutionIdsRef = useRef<Set<string>>(new Set())
  const webExecutionStatesRef = useRef<Map<string, boolean>>(new Map())
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Zero3ProjectRecord[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [linkingProject, setLinkingProject] = useState<Zero3ProjectRecord | null>(null)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [renamingSession, setRenamingSession] = useState<WorkspaceSession | null>(null)
  const [binding, setBinding] = useState<{ project: Zero3ProjectRecord; thenCreate: boolean } | null>(null)

  const sessions = useMemo<WorkspaceSession[]>(() => {
    const web = webSessions.map(session => ({
      ...session,
      completionUnread: completionUnreadSessionIds.has(session.id)
    }))
    const local = localSessions.map(record => ({
      ...LocalSessionAdapter.toWorkspaceSession(record),
      executing: executingLocalSessionIds.has(record.id),
      completionUnread: completionUnreadSessionIds.has(record.id)
    }))
    return [...web, ...local]
  }, [webSessions, localSessions, executingLocalSessionIds, completionUnreadSessionIds])
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )
  const viewedSessionId = activeModule === 'conversations' && activeSession?.provider === provider ? activeSession.id : null
  const createTargetProjectId = resolveCreateProjectId(activeProjectId, focusedProjectId, activeSession)
  const createTargetProject = projects.find(project => project.id === createTargetProjectId) ?? null

  const setSessionCompletionUnread = useCallback((sessionId: string, unread: boolean) => {
    setCompletionUnreadSessionIds(current => {
      if (current.has(sessionId) === unread) return current
      const next = new Set(current)
      if (unread) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])

  const setWebSessionExecution = useCallback((
    sessionId: string,
    status: WebSessionExecutionStatus
  ) => {
    const previous = webExecutionStatesRef.current.get(sessionId)
    webExecutionStatesRef.current.set(sessionId, status.executing)
    setWebSessions(current => current.map(session => session.id === sessionId ? {
      ...session,
      executing: status.executing,
      executionHealth: status.health,
      lastProgressAt: status.lastProgressAt,
      executionIdleForMs: status.idleForMs,
      recoveryAttempt: status.recoveryAttempt
    } : session))
    if (status.health === 'timeout_error' || status.health === 'connection_lost' || status.health === 'recovering' || status.health === 'recovery_failed' || status.health === 'rotating' || status.health === 'rotation_failed') {
      setSessionCompletionUnread(sessionId, false)
    } else if (previous === true && !status.executing && status.health === null) {
      setSessionCompletionUnread(sessionId, viewedSessionIdRef.current !== sessionId)
    }
  }, [setSessionCompletionUnread])

  const refreshWebSessions = useCallback(async () => {
    try {
      const next = await WebWorkspaceAdapter.list()
      const liveIds = new Set(next.map(session => session.id))
      const reconciled = next.map(session => {
        const probed = session.executing === true
        const known = webExecutionStatesRef.current.get(session.id)
        const executing = probed || known === true
        if (probed || known === undefined) webExecutionStatesRef.current.set(session.id, executing)
        return session.executing === executing ? session : { ...session, executing }
      })
      for (const sessionId of [...webExecutionStatesRef.current.keys()]) {
        if (!liveIds.has(sessionId)) webExecutionStatesRef.current.delete(sessionId)
      }
      setWebSessions(reconciled)
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
    return WebWorkspaceAdapter.subscribe(
      () => void refreshWebSessions(),
      (sessionId, status) => setWebSessionExecution(sessionId, status)
    )
  }, [refreshWebSessions, setWebSessionExecution])

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

  useEffect(() => {
    persistCompletionUnreadSessionIds(completionUnreadSessionIds)
  }, [completionUnreadSessionIds])

  useEffect(() => {
    viewedSessionIdRef.current = viewedSessionId
    if (viewedSessionId) setSessionCompletionUnread(viewedSessionId, false)
  }, [viewedSessionId, setSessionCompletionUnread])

  const setLocalSessionExecution = useCallback((sessionId: string, executing: boolean) => {
    const previous = localExecutionIdsRef.current.has(sessionId)
    if (previous === executing) return
    if (executing) localExecutionIdsRef.current.add(sessionId)
    else localExecutionIdsRef.current.delete(sessionId)
    setExecutingLocalSessionIds(new Set(localExecutionIdsRef.current))
    if (previous && !executing) {
      setSessionCompletionUnread(sessionId, viewedSessionIdRef.current !== sessionId)
    }
  }, [setSessionCompletionUnread])

  const selectSession = useCallback((session: WorkspaceSession) => {
    viewedSessionIdRef.current = activeModule === 'conversations' ? session.id : null
    setSessionCompletionUnread(session.id, false)
    setActiveSessionId(session.id)
    setFocusedProjectId(session.projectId)
    setProvider(session.provider)
  }, [activeModule, setSessionCompletionUnread])

  const deleteSession = useCallback(async (session: WorkspaceSession) => {
    try {
      if (session.source === 'local') {
        if (session.provider === 'antigravity') {
          const record = LocalSessionAdapter.get(session.id)
          if (record?.runtimeId) await window.zero3Antigravity.stop({ logicalSessionId: record.runtimeId }).catch(() => {})
        }
        LocalSessionAdapter.remove(session.id)
        setLocalSessionExecution(session.id, false)
        setSessionCompletionUnread(session.id, false)
        refreshLocalSessions()
      } else {
        await WebWorkspaceAdapter.remove(session)
        webExecutionStatesRef.current.delete(session.id)
        setSessionCompletionUnread(session.id, false)
        await refreshWebSessions()
      }
      setActiveSessionId(current => (current === session.id ? null : current))
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshLocalSessions, refreshWebSessions, setLocalSessionExecution, setSessionCompletionUnread])

  const archiveSession = useCallback(async (session: WorkspaceSession, archived: boolean) => {
    try {
      if (archived && activeSessionId === session.id) await hideNativeWebSession(session)
      await SessionArchiveAdapter.setArchived(session, archived)
      if (session.source === 'local') refreshLocalSessions()
      else await refreshWebSessions()
      if (archived) {
        setSessionCompletionUnread(session.id, false)
        setActiveSessionId(current => (current === session.id ? null : current))
      }
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshLocalSessions, refreshWebSessions, setSessionCompletionUnread])
  const renameSession = async (session: WorkspaceSession, title: string) => {
    if (session.source === 'local') {
      LocalSessionAdapter.rename(session.id, title)
      refreshLocalSessions()
    } else {
      await WebWorkspaceAdapter.rename(session, title)
      await refreshWebSessions()
    }
    setSessionError(null)
    setRenamingSession(null)
  }

  const selectProject = useCallback((project: Zero3ProjectRecord) => {
    setActiveProjectId(project.id)
    setFocusedProjectId(project.id)
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== project.id ? null : current
    })
  }, [sessions])

  const selectProjectScope = useCallback((projectId: string | null) => {
    if (projectId !== null) setFocusedProjectId(projectId)
    else if (activeProjectId !== null) setFocusedProjectId(activeProjectId)
    setActiveProjectId(projectId)
    if (projectId === null) return
    setActiveSessionId(current => {
      const active = sessions.find(session => session.id === current)
      return active && active.projectId !== projectId ? null : current
    })
  }, [activeProjectId, sessions])

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
    if (createTargetProject && !createTargetProject.chatGptProjectUrl) {
      setBinding({ project: createTargetProject, thenCreate: true })
      return
    }
    void openGptSession(createTargetProjectId)
  }, [createTargetProject, createTargetProjectId, openGptSession])

  const createSession = useCallback(async (
    nextProvider: WorkspaceProvider,
    options: LocalSessionRuntimeConfig & { zero3ProfileId?: string | null } = {}
  ) => {
    setProviderPickerOpen(false)
    try {
      if (nextProvider === 'gpt') {
        createGptSession()
        return
      }
      if (nextProvider === 'gemini') {
        const id = await WebWorkspaceAdapter.createGeminiWeb(createTargetProjectId)
        setActiveSessionId(id)
        setProvider('gemini')
        await refreshWebSessions()
        return
      }
      const record = LocalSessionAdapter.create(
        nextProvider,
        createTargetProjectId,
        options.zero3ProfileId ?? null,
        { ...options, ...(createTargetProjectId && ['codex','claude','antigravity'].includes(nextProvider)
          ? { projectBinding: await ProjectLinkAdapter.resolve(createTargetProjectId, nextProvider as 'codex' | 'claude' | 'antigravity') } : {}) }
      )
      refreshLocalSessions()
      setActiveSessionId(record.id)
      setProvider(nextProvider)
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [createTargetProjectId, createGptSession, refreshLocalSessions, refreshWebSessions])

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
      await hideNativeWebSession(activeSession)
      setLinkingProject(project)
      setProjectError(null)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession])

  const activeLocalSession = activeSession?.source === 'local'
    ? localSessions.find(session => session.id === activeSession.id) ?? null
    : null
  const activeProject = projects.find(project => project.id === (activeProjectId ?? activeSession?.projectId)) ?? null
  const activeProjectSessionCount = useMemo(
    () => activeProjectId ? sessions.filter(session => session.projectId === activeProjectId && !session.archived).length : 0,
    [sessions, activeProjectId]
  )
  const nativeViewsMayShow = linkingProject === null && binding === null && !providerPickerOpen && renamingSession === null
  const workspaceSession = nativeViewsMayShow ? activeSession : null

  const openProviderPicker = useCallback(async () => {
    try {
      // A native web view is above every renderer z-index. Wait for Electron
      // main to detach it before mounting the picker into the renderer.
      await hideNativeWebSession(activeSession)
      setProviderPickerOpen(true)
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession])

  return (
    <TaskProvider active={activeModule === 'tasks'}>
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar />
      <div className="flex min-h-0 flex-1">
        <GlobalRail activeModule={activeModule} onModuleChange={setActiveModule} />
        <ContextPane
          activeModule={activeModule}
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeProjectId={activeProjectId}
          focusedProjectId={createTargetProjectId}
          sessionError={sessionError}
          projects={projects}
          projectError={projectError}
          onSelectSession={selectSession}
          onSelectProjectContext={setFocusedProjectId}
          onCreateSession={() => void openProviderPicker()}
          onDeleteSession={session => void deleteSession(session)}
          onArchiveSession={(session, archived) => void archiveSession(session, archived)}
          onRenameSession={setRenamingSession}
          onSelectProjectScope={selectProjectScope}
          onSelectProject={selectProject}
          onCreateProject={() => void createProject()}
          runtimeTarget={runtimeTarget}
          onSelectRuntimeTarget={setRuntimeTarget}
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
          onLocalSessionExecutionChange={setLocalSessionExecution}
          onBindChatGptProject={rebindProject}
          onUnbindChatGptProject={project => void unbindProject(project)}
          onOpenPowerShell={() => setInspectorOpen(true)}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
          runtimeTarget={runtimeTarget}
        />
        {inspectorOpen && <InspectorDrawer project={activeProject} onClose={() => setInspectorOpen(false)} />}
      </div>

      {linkingProject && <ProjectLinkDialog project={linkingProject} onClose={() => setLinkingProject(null)} />}
      {renamingSession && (
        <RenameSessionDialog
          session={renamingSession}
          onSave={title => renameSession(renamingSession, title)}
          onCancel={() => setRenamingSession(null)}
        />
      )}

      {providerPickerOpen && (
        <SessionProviderPickerDialog
          project={createTargetProject}
          onCreate={(nextProvider, options) => void createSession(nextProvider, options)}
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
    </TaskProvider>
  )
}
