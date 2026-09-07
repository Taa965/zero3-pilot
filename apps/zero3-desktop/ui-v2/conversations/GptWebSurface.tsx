import { useCallback, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'

type SurfaceStatus = 'loading' | 'ready' | 'error'

function boundsOf(host: HTMLElement) {
  const rect = host.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

export function GptWebSurface() {
  // The ChatGPT page is a native WebContentsView owned by Electron main, not a
  // DOM node. It is positioned over this element's rectangle, so the element
  // stays empty and only serves as the geometry source.
  const hostRef = useRef<HTMLDivElement>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [status, setStatus] = useState<SurfaceStatus>('loading')
  const [detail, setDetail] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let shownId: string | null = null

    const unsubscribe = window.zero3GptWeb.onEvent(event => {
      if (!shownId || event.entryId !== shownId) return
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

    const mount = async () => {
      try {
        // Reuse an existing entry so the signed-in ChatGPT session and its
        // conversation URL survive remounts; only create one on first use.
        const entries = await window.zero3Workspace.list()
        const existing = entries.find(entry => entry.kind === 'gpt_web')
        const entry = existing ?? (await window.zero3GptWeb.create())
        if (cancelled) return
        shownId = entry.id
        setEntryId(entry.id)
        setPageTitle(entry.pageTitle)

        const host = hostRef.current
        if (!host) return
        await window.zero3GptWeb.show({ id: entry.id, bounds: boundsOf(host) })
      } catch (error) {
        if (cancelled) return
        setStatus('error')
        setDetail(error instanceof Error ? error.message : String(error))
      }
    }

    void mount()

    return () => {
      cancelled = true
      unsubscribe()
      // Native views sit above the whole renderer, so leaving one visible would
      // cover the Codex and Gemini surfaces after switching tabs.
      if (shownId) void window.zero3GptWeb.hide({ id: shownId }).catch(() => {})
    }
  }, [])

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
            onClick={reload}
            disabled={!entryId}
            className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background) disabled:opacity-50"
          >
            刷新
          </button>
          <button
            onClick={openExternal}
            disabled={!entryId}
            className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background) disabled:opacity-50"
          >
            在浏览器打开
          </button>
        </div>
      </div>
      <div ref={hostRef} className="relative flex-1 min-h-0">
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
