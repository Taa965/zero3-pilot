import { Codicon } from '@/components/ui/codicon'

import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { PowerShellTerminal } from './PowerShellTerminal'

interface InspectorDrawerProps {
  onClose: () => void
  project: Zero3ProjectRecord | null
}

export function InspectorDrawer({ onClose, project }: InspectorDrawerProps) {
  return (
    <div className="flex w-[460px] shrink-0 flex-col border-l border-(--ui-border) bg-(--ui-pane-background)">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-(--ui-border) px-4">
        <div className="font-medium">属性面板</div>
        <button onClick={onClose} className="text-sm text-(--ui-text-tertiary) hover:text-foreground">
          关闭
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="shrink-0 rounded-md border border-(--ui-border) p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <Codicon name="folder" /> 当前项目
          </div>
          {project ? (
            <>
              <div className="text-sm text-foreground">{project.name}</div>
              <div className="mt-1 break-all font-mono text-xs text-(--ui-text-secondary)">{project.rootPath}</div>
            </>
          ) : (
            <div className="text-xs text-(--ui-text-tertiary)">请先选择一个项目。</div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Codicon name="terminal-powershell" /> PowerShell
            </div>
            {project && <span className="text-[11px] text-(--ui-text-tertiary)">cwd = 当前项目</span>}
          </div>
          {project ? (
            <PowerShellTerminal key={project.id} cwd={project.rootPath} />
          ) : (
            <div className="grid min-h-[280px] flex-1 place-items-center rounded-md border border-dashed border-(--ui-border) text-xs text-(--ui-text-tertiary)">
              选择项目后可启动 PowerShell
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
