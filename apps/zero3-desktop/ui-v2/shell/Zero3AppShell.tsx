import { useCallback, useEffect, useState } from 'react'

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

  const refresh = useCallback(async () => {
    try {
      setSessions(await WebWorkspaceAdapter.list())
      setSessionError(null)
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Titles and conversation URLs are filled in by main as the page navigates,
    // so a session listed right after creation is unnamed until then.
    return WebWorkspaceAdapter.subscribe(() => void refresh())
  }, [refresh])

  const selectSession = useCallback((session: WebSession) => {
    setActiveSessionId(session.id)
    setProvider(session.provider)
  }, [])

  const createGptSession = useCallback(async () => {
    try {
      const id = await WebWorkspaceAdapter.createGptWeb()
      setActiveSessionId(id)
      setProvider('gpt')
      await refresh()
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    }
  }, [refresh])

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? null

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar />
      <div className="flex min-h-0 flex-1">
        <GlobalRail activeModule={activeModule} onModuleChange={setActiveModule} />
        <ContextPane
          activeModule={activeModule}
          sessions={sessions}
          activeSessionId={activeSessionId}
          sessionError={sessionError}
          onSelectSession={selectSession}
          onCreateGptSession={() => void createGptSession()}
        />
        <WorkspaceRouter
          activeModule={activeModule}
          provider={provider}
          onProviderChange={setProvider}
          activeSessionId={activeSession?.provider === 'gpt' ? activeSession.id : null}
          onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
        />
        {inspectorOpen && <InspectorDrawer onClose={() => setInspectorOpen(false)} />}
      </div>
    </div>
  )
}
