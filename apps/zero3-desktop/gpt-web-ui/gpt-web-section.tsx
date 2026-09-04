import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { $activeProjectId } from '@/store/projects'
import { $focusedStoredSessionId } from '@/store/session-states'

export const ZERO3_NEW_SESSION_PROVIDER_EVENT = 'zero3:new-session-provider-picker'

type Zero3GptWebSectionProps = {
  onNewCodexSession: () => void
}

function entryTitle(entry: Zero3WorkspaceEntry): string {
  return entry.localDisplayTitle || entry.pageTitle || (entry.conversationUrl ? 'GPT 网页会话' : '新 GPT 网页会话')
}

function chatSurfaceBounds(): Zero3GptWebBounds | null {
  const host = document.querySelector<HTMLElement>('[data-zero3-gpt-web-host]')
  if (!host) return null
  const rect = host.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  if (width <= 1 || height <= 1) return null
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width,
    height
  }
}

export function Zero3GptWebSection({ onNewCodexSession }: Zero3GptWebSectionProps) {
  const activeProjectId = useStore($activeProjectId)
  const focusedCodexSessionId = useStore($focusedStoredSessionId)
  const [entries, setEntries] = useState<Zero3WorkspaceEntry[]>([])
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const previousCodexSessionIdRef = useRef(focusedCodexSessionId)

  const available = Boolean(window.zero3Workspace && window.zero3GptWeb)

  const refresh = useCallback(async () => {
    if (!available) return
    try {
      const next = await window.zero3Workspace.list()
      setEntries(next.filter(entry => entry.kind === 'gpt_web'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [available])

  const visibleEntries = useMemo(() => {
    const filtered = activeProjectId ? entries.filter(entry => entry.projectId === activeProjectId) : entries
    return [...filtered].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [activeProjectId, entries])

  const hideActive = useCallback(async () => {
    const id = activeEntryId
    if (!id || !available) return
    setActiveEntryId(null)
    try {
      await window.zero3GptWeb.hide({ id })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [activeEntryId, available])

  const activate = useCallback(
    async (id: string) => {
      if (!available) return
      const bounds = chatSurfaceBounds()
      if (!bounds) {
        setError('当前聊天区域尚未准备好，无法显示 GPT 网页会话。')
        return
      }
      setBusy(true)
      setError(null)
      try {
        await window.zero3GptWeb.show({ id, bounds })
        setActiveEntryId(id)
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [available, refresh]
  )

  const create = useCallback(async () => {
    if (!available || busy) return
    setBusy(true)
    setError(null)
    try {
      const entry = await window.zero3GptWeb.create({ projectId: activeProjectId })
      await refresh()
      const bounds = chatSurfaceBounds()
      if (!bounds) throw new Error('当前聊天区域尚未准备好，无法显示 GPT 网页会话。')
      await window.zero3GptWeb.show({ id: entry.id, bounds })
      setActiveEntryId(entry.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [activeProjectId, available, busy, refresh])

  const chooseGptWeb = useCallback(() => {
    setPickerOpen(false)
    void create()
  }, [create])

  const chooseCodex = useCallback(() => {
    setPickerOpen(false)
    void hideActive()
    onNewCodexSession()
  }, [hideActive, onNewCodexSession])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!available) return
    const openPicker = () => setPickerOpen(true)
    window.addEventListener(ZERO3_NEW_SESSION_PROVIDER_EVENT, openPicker)
    return () => window.removeEventListener(ZERO3_NEW_SESSION_PROVIDER_EVENT, openPicker)
  }, [available])

  useEffect(() => {
    if (!available) return
    return window.zero3GptWeb.onEvent(event => {
      if (event.kind === 'navigation') {
        if (event.previousEntryId) {
          setActiveEntryId(current => (current === event.previousEntryId ? event.entryId : current))
        }
        void refresh()
      } else if (event.state === 'created' || event.state === 'suspended') {
        void refresh()
      }
      if (event.kind === 'state' && event.state === 'error') {
        setError(event.detail || 'GPT 网页会话发生错误。')
      }
    })
  }, [available, refresh])

  useEffect(() => {
    if (!activeEntryId || !available) return
    const update = () => {
      const bounds = chatSurfaceBounds()
      if (bounds) void window.zero3GptWeb.setBounds({ id: activeEntryId, bounds })
    }
    const host = document.querySelector<HTMLElement>('[data-zero3-gpt-web-host]')
    const observer = host && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (host && observer) observer.observe(host)
    window.addEventListener('resize', update)
    update()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [activeEntryId, available])

  useEffect(() => {
    if (!activeEntryId) {
      previousCodexSessionIdRef.current = focusedCodexSessionId
      return
    }
    if (previousCodexSessionIdRef.current !== focusedCodexSessionId) {
      void hideActive()
    }
    previousCodexSessionIdRef.current = focusedCodexSessionId
  }, [activeEntryId, focusedCodexSessionId, hideActive])

  useEffect(() => {
    if (!activeEntryId || !available) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-zero3-gpt-web-section]')) return
      void hideActive()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [activeEntryId, available, hideActive])

  if (!available) return null

  return (
    <>
      {(visibleEntries.length > 0 || error) && (
        <div className="shrink-0 px-1 pb-1" data-zero3-gpt-web-section="">
          <div className="flex flex-col gap-px">
            {visibleEntries.map(entry => {
              const active = entry.id === activeEntryId
              return (
                <button
                  className={cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-transparent px-2 text-left text-[0.8125rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                    active && 'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground'
                  )}
                  data-zero3-gpt-web-entry={entry.id}
                  key={entry.id}
                  onClick={() => void activate(entry.id)}
                  title={entryTitle(entry)}
                  type="button"
                >
                  <Codicon className="size-4 shrink-0 text-blue-500" name="globe" />
                  <span className="min-w-0 flex-1 truncate">{entryTitle(entry)}</span>
                  {active && <span className="size-1.5 shrink-0 rounded-full bg-blue-500" aria-label="当前 GPT 网页会话" />}
                </button>
              )
            })}
          </div>

          {error && (
            <button
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background)"
              onClick={() => setError(null)}
              title={error}
              type="button"
            >
              <span className="line-clamp-2">{error}</span>
            </button>
          )}
        </div>
      )}

      <Dialog onOpenChange={setPickerOpen} open={pickerOpen}>
        <DialogContent className="max-w-sm" onOpenAutoFocus={preventCloseButtonAutoFocus} showCloseButton>
          <DialogHeader>
            <DialogTitle>新建会话</DialogTitle>
            <DialogDescription>选择本次会话使用 ChatGPT 网页还是本地 Codex。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              className="h-auto justify-start gap-3 px-3 py-3 text-left"
              disabled={busy}
              onClick={chooseGptWeb}
              variant="outline"
            >
              <Codicon className="size-5 shrink-0 text-blue-500" name="globe" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">GPT Web</span>
                <span className="text-xs font-normal text-(--ui-text-tertiary)">真实 ChatGPT 网页，会话与网页端同步</span>
              </span>
            </Button>
            <Button className="h-auto justify-start gap-3 px-3 py-3 text-left" onClick={chooseCodex} variant="outline">
              <Codicon className="size-5 shrink-0" name="terminal" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">Codex Local</span>
                <span className="text-xs font-normal text-(--ui-text-tertiary)">本地代码开发、命令、测试与真实性执行</span>
              </span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
