import { useCallback, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'

interface GeminiWebSurfaceProps {
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

export function GeminiWebSurface({ entryId }: GeminiWebSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState('created')
  const [title, setTitle] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)

  useEffect(() => {
    if (!entryId) return
    let cancelled = false
    const unsubscribe = window.zero3GeminiWeb.onEvent(event => {
      if (event.entryId !== entryId) return
      if (event.kind === 'navigation') setTitle(event.pageTitle ?? null)
      if (event.kind === 'state') {
        setState(event.state ?? 'error')
        setDetail(event.detail ?? null)
      }
    })

    const show = async () => {
      try {
        const host = hostRef.current
        if (!host) return
        const entry = await window.zero3GeminiWeb.show({ id: entryId, bounds: boundsOf(host) })
        if (!cancelled) setTitle(entry.pageTitle)
      } catch (error) {
        if (!cancelled) {
          setState('error')
          setDetail(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void show()
    return () => {
      cancelled = true
      unsubscribe()
      void window.zero3GeminiWeb.hide({ id: entryId }).catch(() => {})
    }
  }, [entryId])

  useEffect(() => {
    const host = hostRef.current
    if (!entryId || !host) return
    const sync = () => void window.zero3GeminiWeb.setBounds({ id: entryId, bounds: boundsOf(host) }).catch(() => {})
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [entryId])

  const reload = useCallback(() => {
    if (entryId) void window.zero3GeminiWeb.reload({ id: entryId }).catch(() => {})
  }, [entryId])

  const openExternal = useCallback(() => {
    if (entryId) void window.zero3GeminiWeb.openExternal({ id: entryId }).catch(() => {})
  }, [entryId])

  if (!entryId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-(--ui-text-secondary)">
        <Codicon name="globe" className="mb-4 size-12 text-violet-500 opacity-50" />
        <div>从左侧选择一个 Gemini 网页会话</div>
        <div className="mt-2 text-xs text-(--ui-text-tertiary)">或点击列表上方的 ＋ 新建会话</div>
      </div>
    )
  }

  const ready = state === 'ready' || state === 'shown'
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--ui-border) px-4 text-sm">
        <span className="truncate text-(--ui-text-secondary)">{title ?? 'Gemini'}</span>
        <span className={ready ? 'text-xs text-green-600' : state === 'error' ? 'text-xs text-red-600' : 'text-xs text-(--ui-text-tertiary)'}>
          {ready ? '已就绪' : state === 'error' ? '加载失败' : '加载中…'}
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={reload} className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">刷新</button>
          <button onClick={openExternal} className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">在浏览器打开</button>
        </div>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background text-(--ui-text-secondary)">
            <Codicon name="globe" className="mb-4 size-12 text-violet-500 opacity-50" />
            <div>{state === 'error' ? 'Gemini 视图加载失败' : '正在加载 Gemini…'}</div>
            {detail && <div className="mt-2 max-w-md text-center text-xs text-(--ui-text-tertiary)">{detail}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
