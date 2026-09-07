import { useCallback, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'

type SurfaceStatus = 'idle' | 'loading' | 'ready' | 'error'

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

export function GptWebSurface({ entryId }: GptWebSurfaceProps) {
  // The ChatGPT page is a native WebContentsView owned by Electron main, not a
  // DOM node. It is positioned over this element's rectangle, so the element
  // stays empty and only serves as the geometry source.
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<SurfaceStatus>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [railVisible, setRailVisible] = useState(false)

  useEffect(() => {
    if (!entryId) {
      setStatus('idle')
      return
    }

    let cancelled = false
    setStatus('loading')
    setDetail(null)

    const unsubscribe = window.zero3GptWeb.onEvent(event => {
      if (event.entryId !== entryId) return
      if (event.kind === 'navigation') {
        setPageTitle(event.pageTitle)
        return
      }
      if (event.state === 'loading') setStatus('loading')
      else if (event.state === 'ready' || event.state === 'shown') setStatus('ready')
      else if (event.state === 'error') {
        setStatus('error')
        setDetail(event.detail ?? null)
      }
    })

    const show = async () => {
      try {
        const host = hostRef.current
        if (!host) return
        const entry = await window.zero3GptWeb.show({ id: entryId, bounds: boundsOf(host) })
        if (cancelled) return
        setPageTitle(entry.pageTitle)
        // Each view starts with ChatGPT's own rail suppressed, so a surface
        // remounted after the toggle was flipped must not claim otherwise.
        setRailVisible(false)
      } catch (error) {
        if (cancelled) return
        setStatus('error')
        setDetail(error instanceof Error ? error.message : String(error))
      }
    }

    void show()

    return () => {
      cancelled = true
      unsubscribe()
      // Native views sit above the whole renderer, so leaving one visible would
      // cover the Codex and Gemini surfaces after switching away.
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

  const toggleRail = useCallback(() => {
    if (!entryId) return
    const next = !railVisible
    setRailVisible(next)
    void window.zero3GptWeb.setChromeVisible({ id: entryId, visible: next }).catch(() => {})
  }, [entryId, railVisible])

  if (!entryId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-(--ui-text-secondary)">
        <Codicon name="globe" className="mb-4 size-12 text-blue-500 opacity-50" />
        <div>从左侧选择一个 GPT 网页会话</div>
        <div className="mt-2 text-xs text-(--ui-text-tertiary)">或点击列表上方的 ＋ 新建一个</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--ui-border) px-4 text-sm">
        <span className="truncate text-(--ui-text-secondary)">{pageTitle ?? 'ChatGPT'}</span>
        <span
          className={
            status === 'ready'
              ? 'text-xs text-green-600'
              : status === 'error'
                ? 'text-xs text-red-600'
                : 'text-xs text-(--ui-text-tertiary)'
          }
        >
          {status === 'ready' ? '已就绪' : status === 'error' ? '加载失败' : '加载中…'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={toggleRail}
            title="ChatGPT 自带的会话栏默认隐藏，需要翻它的历史对话时可临时显示"
            className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)"
          >
            {railVisible ? '隐藏 ChatGPT 会话栏' : '显示 ChatGPT 会话栏'}
          </button>
          <button
            onClick={reload}
            className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)"
          >
            刷新
          </button>
          <button
            onClick={openExternal}
            className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)"
          >
            在浏览器打开
          </button>
        </div>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1">
        {status !== 'ready' && (
          <div className="flex h-full flex-col items-center justify-center text-(--ui-text-secondary)">
            <Codicon name="globe" className="mb-4 size-12 text-blue-500 opacity-50" />
            <div>{status === 'error' ? 'ChatGPT 视图加载失败' : '正在加载 ChatGPT…'}</div>
            {detail && <div className="mt-2 max-w-md text-center text-xs text-(--ui-text-tertiary)">{detail}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
