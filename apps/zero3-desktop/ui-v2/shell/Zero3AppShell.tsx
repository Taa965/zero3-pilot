import { useState } from 'react'
import { AppTitleBar } from './AppTitleBar'
import { GlobalRail } from './GlobalRail'
import { ContextPane } from './ContextPane'
import { WorkspaceRouter } from './WorkspaceRouter'
import { InspectorDrawer } from './InspectorDrawer'

export function Zero3AppShell() {
  const [activeModule, setActiveModule] = useState<'conversations' | 'tasks' | 'groups' | 'projects' | 'runtime'>('conversations')
  const [inspectorOpen, setInspectorOpen] = useState(false)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar />
      <div className="flex flex-1 min-h-0">
        <GlobalRail activeModule={activeModule} onModuleChange={setActiveModule} />
        <ContextPane activeModule={activeModule} />
        <WorkspaceRouter activeModule={activeModule} onToggleInspector={() => setInspectorOpen(!inspectorOpen)} />
        {inspectorOpen && <InspectorDrawer onClose={() => setInspectorOpen(false)} />}
      </div>
    </div>
  )
}
