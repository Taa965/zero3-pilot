import { useCallback, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'

type SurfaceStatus = 'cold' | 'warming' | 'warm' | 'visible' | 'suspended' | 'error'
type ToolbarAction = 'sidebar' | 'new_chat' | 'share' | 'more'

interface GptWebSurfaceProps {
  /** Workspace entry chosen in the session list; null until one is selected. */
  entryId: string | null
}

function boundsOf(host: HTMLElement) {
  const rect = host.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

function normalizeState(state: string): SurfaceStatus | null {
  if (state === 'cold' || state === 'created') return 'cold'
  if (state === 'warming' || state === 'loading') return 'warming'
  if (state === 'warm' || state === 'ready' || state === 'hidden') return 'warm'
  if (state === 'visible' || state === 'shown') return 'visible'
  if (state === 'suspended') return 'suspended'
  if (state === 'error') return 'error'
  return null
}

function statusText(status: SurfaceStatus) {
  if (status === 'visible') return '已就绪'
  if (status === 'warm') return '已预热'
  if (status === 'warming') return '恢复中…'
  if (status === 'suspended') return '已休眠'
  if (status === 'error') return '加载失败'
  return '准备中…'
}

export function GptWebSurface({ entryId }: GptWebSurfaceProps) {
  // The ChatGPT page is a native WebContentsView owned by Electron main, not a
  // DOM node. It is positioned over this element's rectangle, so the element
  // stays empty and only serves as the geometry source.
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<SurfaceStatus>('cold')
  const [detail, setDetail] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  const [showFallback, setShowFallback] = useState(false)

  useEffect(() => {
    if (!entryId) {
      setStatus('cold')
      setSnapshotUrl(null)
      setShowFallback(false)
      return
    }

    let cancelled = false
    setStatus('cold')
    setDetail(null)
    setSnapshotUrl(null)
    setShowFallback(false)

    // Warm sessions normally become visible well before this timer fires. The
    // small delay keeps a fast hot-pool switch from flashing a fake loading UI.
    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled) setShowFallback(true)
    }, 120)

    const unsubscribe = window.zero3GptWeb.onEvent(event => {
      if (event.entryId !== entryId) return
      if (event.kind === 'navigation') {
        setPageTitle(event.pageTitle)
        return
      }
      const next = normalizeState(event.state)
      if (next) setStatus(next)
      if (next === 'visible') {
        setShowFallback(false)
        setSnapshotUrl(null)
      } else if (next === 'error') {
        setDetail(event.detail ?? null)
        setShowFallback(true)
      }
    })

    const restoreSnapshot = async () => {
      try {
        const snapshot = await window.zero3GptWeb.snapshot({ id: entryId })
        if (!cancelled && snapshot.dataUrl) setSnapshotUrl(snapshot.dataUrl)
      } catch {
        // Snapshotting is a best-effort visual optimization. A missing snapshot
        // should fall back to the normal lightweight restore surface.
      }
    }

    const show = async () => {
      try {
        const host = hostRef.current
        if (!host) return
        const entry = await window.zero3GptWeb.show({ id: entryId, bounds: boundsOf(host) })
        if (cancelled) return
        // show() spans an IPC round trip and a possible cold-page warmup, so the
        // rect measured before it can already be stale.
        void window.zero3GptWeb.setBounds({ id: entryId, bounds: boundsOf(host) }).catch(() => {})
        setPageTitle(entry.pageTitle)
      } catch (error) {
        if (cancelled) return
        setStatus('error')
        setShowFallback(true)
        setDetail(error instanceof Error ? error.message : String(error))
      }
    }

    void restoreSnapshot()
    void show()

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      unsubscribe()
      // Native views sit above the whole renderer, so leaving one visible would
      // cover the Codex and Gemini surfaces after switching away. Main captures
      // a small in-memory JPEG before detaching it for future cold restoration.
      void window.zero3GptWeb.hide({ id: entryId }).catch(() => {})
    }
  }, [entryId])

  useEffect(() => {
    const host = hostRef.current
    if (!entryId || !host) return

    const sync = () => {
      void window.zero3GptWeb.setBounds({ id: entryId, bounds: boundsOf(host) }).catch(() => {})
    }

    // ResizeObserver catches pane resizes; the window listener catches moves
    // that change the element's viewport offset without changing its size.
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [entryId])

  const reload = useCallback(() => {
    if (entryId) void window.zero3GptWeb.reload({ id: entryId }).catch(() => {})
  }, [entryId])

  const openExternal = useCallback(() => {
    if (entryId) void window.zero3GptWeb.openExternal({ id: entryId }).catch(() => {})
  }, [entryId])

  const toolbarAction = useCallback((action: ToolbarAction) => {
    if (entryId) void window.zero3GptWeb.toolbarAction({ id: entryId, action }).catch(() => {})
  }, [entryId])

  if (!entryId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-(--ui-text-secondary)">
        <Codicon name="globe" className="mb-4 size-12 text-blue-500 opacity-50" />
        <div>从左侧选择一个 GPT 网页会话</div>
        <div className="mt-2 text-xs text-(--ui-text-tertiary)">或点击列表上方的 ＋ 新建一个</div>
      </div>
    )
  }

  const fallbackVisible = status !== 'visible' && (showFallback || Boolean(snapshotUrl))

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--ui-border) px-4 text-sm">
        <button
          onClick={() => toolbarAction('sidebar')}
          title="ChatGPT 侧边栏"
          aria-label="ChatGPT 侧边栏"
          className="grid size-8 shrink-0 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
        >
          <Codicon name="menu" className="text-base" />
        </button>
        <span className="truncate text-(--ui-text-secondary)">{pageTitle ?? 'ChatGPT'}</span>
        <span
          className={
            status === 'visible'
              ? 'text-xs text-green-600'
              : status === 'error'
                ? 'text-xs text-red-600'
                : 'text-xs text-(--ui-text-tertiary)'
          }
        >
          {statusText(status)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => toolbarAction('new_chat')}
            title="新聊天"
            aria-label="新聊天"
            className="grid size-8 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
          >
            <Codicon name="edit" className="text-base" />
          </button>
          <button
            onClick={() => toolbarAction('share')}
            title="分享聊天"
            aria-label="分享聊天"
            className="grid size-8 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
          >
            <Codicon name="share" className="text-base" />
          </button>
          <button
            onClick={() => toolbarAction('more')}
            title="更多"
            aria-label="更多"
            className="grid size-8 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
          >
            <Codicon name="ellipsis" className="text-base" />
          </button>
          <div className="mx-1 h-4 w-px bg-(--ui-border)" aria-hidden="true" />
          <button
            onClick={reload}
            title="刷新"
            aria-label="刷新"
            className="grid size-8 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
          >
            <Codicon name="refresh" className="text-base" />
          </button>
          <button
            onClick={openExternal}
            title="在浏览器打开"
            aria-label="在浏览器打开"
            className="grid size-8 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
          >
            <Codicon name="link-external" className="text-base" />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        {fallbackVisible && snapshotUrl && (
          <div className="absolute inset-0 bg-background">
            <img
              src={snapshotUrl}
              alt="上次会话画面"
              className="h-full w-full object-cover object-top"
              draggable={false}
            />
            {status !== 'error' && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-(--ui-border) bg-(--ui-pane-background) px-3 py-1 text-xs text-(--ui-text-secondary) shadow-sm">
                正在恢复实时页面…
              </div>
            )}
          </div>
        )}
        {fallbackVisible && !snapshotUrl && (
          <div className="flex h-full flex-col items-center justify-center text-(--ui-text-secondary)">
            <Codicon name="globe" className="mb-4 size-12 text-blue-500 opacity-50" />
            <div>{status === 'error' ? 'ChatGPT 视图加载失败' : '正在恢复 ChatGPT…'}</div>
            {detail && <div className="mt-2 max-w-md text-center text-xs text-(--ui-text-tertiary)">{detail}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
