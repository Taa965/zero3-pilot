import { useCallback, useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { WebWorkspaceAdapter, type ChatGptRemoteProject } from '../adapters/WebWorkspaceAdapter'

interface ChatGptProjectBindingDialogProps {
  /** Zero3 project being bound; its name anchors the "which one is this?" question. */
  projectName: string
  /** URL already bound, so a re-bind opens with the current choice marked. */
  boundUrl: string | null
  onBind: (url: string) => void
  onSkip: () => void
  onCancel: () => void
}

function normalizedProjectUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return null
    if (parsed.hostname.toLowerCase() !== 'chatgpt.com') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function ChatGptProjectBindingDialog({
  projectName,
  boundUrl,
  onBind,
  onSkip,
  onCancel
}: ChatGptProjectBindingDialogProps) {
  const [projects, setProjects] = useState<ChatGptRemoteProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(boundUrl)
  const [manualUrl, setManualUrl] = useState('')

  const load = useCallback(async () => {
    setProjects(null)
    setError(null)
    try {
      setProjects(await WebWorkspaceAdapter.listChatGptProjects())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const manual = normalizedProjectUrl(manualUrl)
  const target = manualUrl.trim() ? manual : selected

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-(--ui-border) bg-background shadow-xl">
        <div className="shrink-0 border-b border-(--ui-border) px-5 py-4">
          <div className="text-base font-medium">关联 ChatGPT 项目</div>
          <div className="mt-1 text-xs text-(--ui-text-secondary)">
            «{projectName}» 下的 GPT 网页会话将统一建在你选中的 ChatGPT 项目里，之后不再询问。
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {projects === null && !error && (
            <div className="flex items-center gap-2 py-8 text-sm text-(--ui-text-secondary)">
              <Codicon name="loading" className="size-4 animate-spin" />
              正在读取 ChatGPT 的项目列表…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3 text-xs">
              <div className="text-red-600">{error}</div>
              <button
                onClick={() => void load()}
                className="mt-2 rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)"
              >
                重试
              </button>
            </div>
          )}

          {projects?.map(project => (
            <button
              key={project.id}
              onClick={() => {
                setSelected(project.url)
                setManualUrl('')
              }}
              className={cn(
                'mb-1 flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors',
                selected === project.url && !manualUrl.trim()
                  ? 'border-blue-500 bg-(--ui-control-active-background)'
                  : 'border-transparent hover:bg-(--ui-control-hover-background)'
              )}
            >
              <Codicon name="folder" className="size-4 shrink-0 text-blue-500" />
              <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
              {project.url === boundUrl && (
                <span className="shrink-0 text-xs text-(--ui-text-tertiary)">当前</span>
              )}
            </button>
          ))}

          {projects?.length === 0 && (
            <div className="py-8 text-center text-xs text-(--ui-text-tertiary)">
              ChatGPT 账号下没有项目，可先去 ChatGPT 建一个，或在下方直接粘贴项目链接。
            </div>
          )}

          {/* The catalog is read out of ChatGPT's own page, so a redesign there
              can leave it empty. Pasting the project URL from the address bar
              always works and reaches the same binding. */}
          <div className="mt-3 border-t border-(--ui-border) pt-3">
            <div className="text-xs text-(--ui-text-tertiary)">或粘贴 ChatGPT 项目链接</div>
            <input
              value={manualUrl}
              onChange={event => setManualUrl(event.target.value)}
              placeholder="https://chatgpt.com/g/g-p-…/project"
              className="mt-2 w-full rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 py-1.5 text-sm text-foreground outline-none focus:border-blue-500"
            />
            {manualUrl.trim() && !manual && (
              <div className="mt-1 text-xs text-red-600">需要是 https://chatgpt.com 下的链接</div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-(--ui-border) px-5 py-3">
          <button
            onClick={onSkip}
            className="rounded-md px-3 py-1.5 text-sm text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)"
          >
            本次不关联
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="rounded-md border border-(--ui-border) px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background)"
            >
              取消
            </button>
            <button
              onClick={() => target && onBind(target)}
              disabled={!target}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
            >
              关联并新建会话
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
