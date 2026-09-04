import { useStore } from '@nanostores/react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { $activeProjectId } from '@/store/projects'
import { $focusedStoredSessionId } from '@/store/session-states'

export const ZERO3_GEMINI_OPEN_ENTRY_EVENT = 'zero3:gemini-open-entry'
export const ZERO3_WEB_PROVIDER_ACTIVATED_EVENT = 'zero3:web-provider-activated'

type GeminiEntry = {
  id: string
  kind: 'gemini_web'
  logicalSessionId: string
  projectId: string | null
  conversationUrl: string | null
  pageTitle: string | null
  localDisplayTitle: string | null
  lastActiveAt: string
}

type GeminiWebBridge = {
  create(request?: { projectId?: string | null }): Promise<GeminiEntry>
  show(request: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<GeminiEntry>
  hide(request: { id: string }): Promise<{ hidden: boolean }>
  setBounds(request: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<{ ok: true }>
  openExternal(request: { id: string }): Promise<{ opened: boolean }>
  onEvent(callback: (event: any) => void): () => void
}

type AntigravityStatus = { available: boolean; binary: string | null; activeSessions: string[] }
type AntigravityBridge = {
  status(): Promise<AntigravityStatus>
  binding(request: { logicalSessionId: string }): Promise<any>
  startTurn(request: { logicalSessionId: string; projectId?: string | null; cwd: string; prompt: string; taskId?: string | null; contextVersion?: number | null }): Promise<{ turnId: string }>
  waitTurn(request: { turnId: string }): Promise<any>
  interrupt(request: { logicalSessionId: string }): Promise<{ interrupted: boolean }>
  onEvent(callback: (event: any) => void): () => void
}

type ArtifactBridge = { list(request: { taskId: string }): Promise<any[]> }
type ReviewBridge = { get(request: { taskId: string }): Promise<any> }
type GeminiTab = 'web' | 'runtime' | 'artifacts' | 'diff' | 'reviews'

function bridges() {
  const value = window as unknown as {
    zero3Workspace?: { list(): Promise<any[]> }
    zero3GeminiWeb?: GeminiWebBridge
    zero3Antigravity?: AntigravityBridge
    zero3Artifacts?: ArtifactBridge
    zero3Review?: ReviewBridge
  }
  return value
}
function hostBounds() {
  const host = document.querySelector<HTMLElement>('[data-zero3-gpt-web-host]')
  if (!host) return null
  const rect = host.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  return { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.round(rect.width), height: Math.round(rect.height) }
}
function title(entry: GeminiEntry) {
  return entry.localDisplayTitle || entry.pageTitle || (entry.conversationUrl ? 'Gemini 会话' : '新 Gemini 会话')
}

export function Zero3GeminiSessionSection() {
  const activeProjectId = useStore($activeProjectId)
  const focusedCodexSessionId = useStore($focusedStoredSessionId)
  const api = useMemo(bridges, [])
  const [entries, setEntries] = useState<GeminiEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<GeminiTab>('web')
  const [taskId, setTaskId] = useState('')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [runtimeEvents, setRuntimeEvents] = useState<any[]>([])
  const [runtimeResult, setRuntimeResult] = useState<any>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<AntigravityStatus | null>(null)
  const [runtimeBinding, setRuntimeBinding] = useState<any>(null)
  const [artifacts, setArtifacts] = useState<any[]>([])
  const [review, setReview] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const previousCodex = useRef(focusedCodexSessionId)

  const refresh = useCallback(async () => {
    if (!api.zero3Workspace) return
    const all = await api.zero3Workspace.list()
    setEntries(all.filter((entry): entry is GeminiEntry => entry?.kind === 'gemini_web'))
  }, [api])

  const visible = useMemo(() => {
    const values = activeProjectId ? entries.filter(entry => entry.projectId === activeProjectId) : entries
    return [...values].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [activeProjectId, entries])
  const active = activeId ? entries.find(entry => entry.id === activeId) ?? null : null

  const hide = useCallback(async () => {
    if (activeId && api.zero3GeminiWeb) await api.zero3GeminiWeb.hide({ id: activeId }).catch(() => undefined)
    setActiveId(null)
  }, [activeId, api])

  const activate = useCallback(async (entryId: string, nextTab: GeminiTab = 'web') => {
    if (!api.zero3GeminiWeb) return
    const entry = entries.find(value => value.id === entryId) ?? (await api.zero3Workspace?.list())?.find(value => value.id === entryId)
    if (!entry || entry.kind !== 'gemini_web') return
    window.dispatchEvent(new CustomEvent(ZERO3_WEB_PROVIDER_ACTIVATED_EVENT, { detail: { provider: 'GEMINI', entryId } }))
    setActiveId(entryId)
    setTab(nextTab)
    if (nextTab === 'web') {
      const bounds = hostBounds()
      if (!bounds) throw new Error('主工作区尚未准备好')
      await api.zero3GeminiWeb.show({ id: entryId, bounds })
    } else {
      await api.zero3GeminiWeb.hide({ id: entryId }).catch(() => undefined)
    }
    if (api.zero3Antigravity) {
      setRuntimeStatus(await api.zero3Antigravity.status())
      setRuntimeBinding(await api.zero3Antigravity.binding({ logicalSessionId: entry.logicalSessionId }))
    }
    await refresh()
  }, [api, entries, refresh])

  useEffect(() => { void refresh().catch(reason => setError(String(reason))) }, [refresh])
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail
      if (detail?.entryId) void activate(detail.entryId).catch(reason => setError(String(reason)))
    }
    window.addEventListener(ZERO3_GEMINI_OPEN_ENTRY_EVENT, listener)
    return () => window.removeEventListener(ZERO3_GEMINI_OPEN_ENTRY_EVENT, listener)
  }, [activate])
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string }>).detail
      if (detail?.provider === 'GPT' && activeId) void hide()
    }
    window.addEventListener(ZERO3_WEB_PROVIDER_ACTIVATED_EVENT, listener)
    return () => window.removeEventListener(ZERO3_WEB_PROVIDER_ACTIVATED_EVENT, listener)
  }, [activeId, hide])
  useEffect(() => {
    if (!api.zero3GeminiWeb) return
    return api.zero3GeminiWeb.onEvent(event => {
      if (event.kind === 'navigation') {
        if (event.previousEntryId) setActiveId(current => current === event.previousEntryId ? event.entryId : current)
        void refresh()
      }
    })
  }, [api, refresh])
  useEffect(() => {
    if (!api.zero3Antigravity) return
    return api.zero3Antigravity.onEvent(event => {
      if (!active || event.logicalSessionId !== active.logicalSessionId) return
      setRuntimeEvents(current => [...current.slice(-199), event])
      if (event.type === 'provider.auth.required' || event.type === 'provider.health.changed' || event.type === 'agent.runtime.started') {
        void api.zero3Antigravity!.status().then(setRuntimeStatus).catch(() => undefined)
        void api.zero3Antigravity!.binding({ logicalSessionId: active.logicalSessionId }).then(setRuntimeBinding).catch(() => undefined)
      }
    })
  }, [active, api])
  useEffect(() => {
    if (!activeId || !api.zero3GeminiWeb || tab !== 'web') return
    const update = () => { const value = hostBounds(); if (value) void api.zero3GeminiWeb!.setBounds({ id: activeId, bounds: value }) }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    const host = document.querySelector<HTMLElement>('[data-zero3-gpt-web-host]')
    if (observer && host) observer.observe(host)
    window.addEventListener('resize', update); update()
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [activeId, api, tab])
  useEffect(() => {
    if (activeId && previousCodex.current !== focusedCodexSessionId) void hide()
    previousCodex.current = focusedCodexSessionId
  }, [activeId, focusedCodexSessionId, hide])

  const changeTab = async (next: GeminiTab) => {
    if (!active || !api.zero3GeminiWeb) return
    setTab(next)
    if (next === 'web') {
      const bounds = hostBounds(); if (bounds) await api.zero3GeminiWeb.show({ id: active.id, bounds })
    } else {
      await api.zero3GeminiWeb.hide({ id: active.id }).catch(() => undefined)
    }
    if (next === 'runtime' && api.zero3Antigravity) {
      setRuntimeStatus(await api.zero3Antigravity.status())
      setRuntimeBinding(await api.zero3Antigravity.binding({ logicalSessionId: active.logicalSessionId }))
    }
    if (next === 'artifacts' && taskId && api.zero3Artifacts) setArtifacts(await api.zero3Artifacts.list({ taskId }))
    if (next === 'reviews' && taskId && api.zero3Review) setReview(await api.zero3Review.get({ taskId }))
  }

  const startTurn = async () => {
    if (!active || !api.zero3Antigravity) return
    setError(null); setRuntimeResult(null); setRuntimeEvents([])
    try {
      const status = await api.zero3Antigravity.status()
      setRuntimeStatus(status)
      if (!status.available) throw new Error('未检测到官方 Antigravity CLI (agy)。请先安装并使用官方 agy 完成 Google 登录。')
      const started = await api.zero3Antigravity.startTurn({ logicalSessionId: active.logicalSessionId, projectId: active.projectId, cwd, prompt, taskId: taskId || null })
      setTab('runtime')
      await api.zero3GeminiWeb?.hide({ id: active.id }).catch(() => undefined)
      setRuntimeResult(await api.zero3Antigravity.waitTurn({ turnId: started.turnId }))
      setRuntimeBinding(await api.zero3Antigravity.binding({ logicalSessionId: active.logicalSessionId }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const host = active && tab !== 'web' ? document.querySelector<HTMLElement>('[data-zero3-gpt-web-host]') : null

  return <>
    {visible.length > 0 && <div className="shrink-0 px-1 pb-1" data-zero3-gemini-section="">
      {visible.map(entry => <button key={entry.id} type="button" onClick={() => void activate(entry.id)} className={cn('flex h-8 w-full items-center gap-2 rounded-md border border-transparent px-2 text-left text-[0.8125rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)', entry.id === activeId && 'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground')}>
        <span className="grid size-4 place-items-center font-semibold text-violet-500">✦</span><span className="min-w-0 flex-1 truncate">{title(entry)}</span>
      </button>)}
      {active && <div className="flex flex-wrap gap-1 px-2 py-1" data-zero3-gemini-section="">
        {(['web','runtime','artifacts','diff','reviews'] as GeminiTab[]).map(value => <Button key={value} size="sm" variant={tab === value ? 'secondary' : 'ghost'} className="h-6 px-2 text-[0.6875rem]" onClick={() => void changeTab(value)}>{({web:'网页对话',runtime:'任务执行',artifacts:'Artifacts',diff:'Diff',reviews:'Review Cycles'} as Record<GeminiTab,string>)[value]}</Button>)}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[0.6875rem]" onClick={() => void api.zero3GeminiWeb?.openExternal({ id: active.id })}><Codicon name="link-external" className="mr-1 size-3"/>浏览器</Button>
      </div>}
      {error && <div className="px-2 py-1 text-[0.6875rem] text-destructive">{error}</div>}
    </div>}

    {host && createPortal(<div className="absolute inset-0 z-20 overflow-auto bg-(--ui-bg-base) p-4 text-foreground" data-zero3-gemini-runtime-panel="">
      <div className="mx-auto flex max-w-5xl flex-col gap-3">
        <div className="flex items-center justify-between"><div><div className="font-semibold">✦ {active ? title(active) : 'Gemini'}</div><div className="text-xs text-(--ui-text-tertiary)">Gemini · Antigravity Runtime · {tab}</div></div><Button size="sm" variant="ghost" onClick={() => active && void changeTab('web')}>返回网页</Button></div>
        {tab === 'runtime' && <>
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3 text-xs">
            <div>CLI: {runtimeStatus?.available ? 'AVAILABLE' : 'UNAVAILABLE'} {runtimeStatus?.binary ? `· ${runtimeStatus.binary}` : ''}</div>
            <div>Auth/Binding: {runtimeBinding?.authState ?? 'UNKNOWN'} · Conversation {runtimeBinding?.conversationId ?? '尚未建立'}</div>
            {(runtimeBinding?.authState === 'AUTH_REQUIRED' || runtimeBinding?.authState === 'AUTH_EXPIRED') && <div className="mt-1 text-(--ui-text-tertiary)">请在本机终端运行官方 <code>agy</code> 完成 Google 登录/重新登录。Zero3 不读取或导出凭据。</div>}
          </div>
          <div className="grid gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3">
            <input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs" placeholder="Task ID" value={taskId} onChange={e => setTaskId(e.target.value)} />
            <input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs" placeholder="独立 Worktree / cwd" value={cwd} onChange={e => setCwd(e.target.value)} />
            <textarea className="min-h-24 rounded-md border border-(--ui-stroke-secondary) bg-transparent p-2 text-xs" placeholder="TaskSpec / FixRequest（不会读取 Gemini 网页 DOM）" value={prompt} onChange={e => setPrompt(e.target.value)} />
            <div className="flex gap-2"><Button size="sm" onClick={() => void startTurn()}>启动 Antigravity</Button><Button size="sm" variant="outline" onClick={() => active && void api.zero3Antigravity?.interrupt({ logicalSessionId: active.logicalSessionId })}>中断</Button></div>
          </div>
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3"><div className="mb-2 text-xs font-medium">Runtime Events</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[0.6875rem]">{runtimeEvents.map(event => `${event.at} ${event.type} ${JSON.stringify(event.payload)}\n`).join('')}</pre></div>
          {runtimeResult && <div className="rounded-lg border border-(--ui-stroke-secondary) p-3"><div className="mb-2 text-xs font-medium">Execution Result</div><pre className="whitespace-pre-wrap text-[0.6875rem]">{JSON.stringify(runtimeResult, null, 2)}</pre></div>}
        </>}
        {tab === 'artifacts' && <pre className="rounded-lg border border-(--ui-stroke-secondary) p-3 text-xs">{taskId ? JSON.stringify(artifacts, null, 2) : '输入/绑定 Task ID 后查看 Artifact。'}</pre>}
        {tab === 'diff' && <div className="rounded-lg border border-(--ui-stroke-secondary) p-3 text-xs text-(--ui-text-secondary)">Diff 以 Task Worktree / Git evidence 为事实源；本面板不从 Gemini 回复文本猜测 Diff。</div>}
        {tab === 'reviews' && <pre className="rounded-lg border border-(--ui-stroke-secondary) p-3 text-xs">{taskId ? JSON.stringify(review, null, 2) : '输入/绑定 Task ID 后查看 Review Cycles。'}</pre>}
      </div>
    </div>, host)}
  </>
}
