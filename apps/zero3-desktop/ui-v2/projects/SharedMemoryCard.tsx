import { useEffect, useState } from 'react'

type MemoryView = {
  mode: 'shared' | 'unconfigured'
  error?: string
  context?: { version: number; payload: unknown; sync: { stale: boolean; last_sequence: number } } | null
  status?: { state: string; queue: Record<string, number> }
}
type Bridge = { read: (request: { projectId: string }) => Promise<MemoryView>; importConfig: () => Promise<{ imported: boolean }> }
const bridge = () => (window as Window & { zero3SharedMemory?: Bridge }).zero3SharedMemory

export function SharedMemoryCard({ projectId }: { projectId: string }) {
  const [view, setView] = useState<MemoryView | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    setView(null); setError('')
    const refresh = async () => {
      try { const next = await bridge()?.read({ projectId }); if (active && next) { setView(next); setError('') } }
      catch { if (active) setError('无法读取共享记忆连接配置，请检查配置后重试。') }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => { active = false; clearInterval(timer) }
  }, [projectId, revision])
  async function importConfig() {
    setBusy(true)
    try { if ((await bridge()?.importConfig())?.imported) setRevision(value => value + 1) }
    catch { setError('连接配置导入失败，请检查服务地址、项目范围和凭据。') }
    finally { setBusy(false) }
  }
  if (!bridge()) return <p className="text-sm text-(--ui-text-secondary)">请重启更新后的应用以加载共享记忆。</p>
  const queue = view?.status?.queue ?? {}
  return <section className="max-w-3xl rounded-lg border border-(--ui-border) bg-background p-5 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-medium">共享记忆</h2>
      <div className="flex gap-2">
        <button className="rounded border border-(--ui-border) px-3 py-1" onClick={() => setRevision(value => value + 1)}>刷新</button>
        <button disabled={busy} className="rounded border border-(--ui-border) px-3 py-1" onClick={() => void importConfig()}>导入连接配置</button>
      </div>
    </div>
    {view?.mode === 'unconfigured' && <p className="mt-4 text-(--ui-text-secondary)">此项目尚未连接共享记忆。导入包含此项目的连接配置后，新开的 AI 会话即可读写同一份记忆。</p>}
    {view?.mode === 'shared' && <>
      <p className="mt-4">{view.context ? (view.context.sync.stale ? '离线缓存 · 内容可能已过期' : '已读取服务器确认的记忆') : '正在等待共享记忆服务'}</p>
      <div className="mt-3 flex flex-wrap gap-5 text-(--ui-text-secondary)">
        <span>待同步 {(queue.pending ?? 0) + (queue.sending ?? 0)}</span>
        <span>版本冲突 {queue.conflict ?? 0}</span><span>已拒绝 {queue.rejected ?? 0}</span>
        {view.context && <span>项目版本 {view.context.version}</span>}
      </div>
      {(queue.conflict ?? 0) > 0 && <p className="mt-3 text-amber-600">存在版本冲突。请让 AI 重新读取最新记忆后合并，再发布新事件。</p>}
      {view.context && <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-(--ui-pane-background) p-4 text-xs">{JSON.stringify(view.context.payload, null, 2)}</pre>}
    </>}
    {(error || view?.error) && <p role="alert" className="mt-3 text-red-600">{error || view?.error}</p>}
    <p className="mt-4 text-xs text-(--ui-text-tertiary)">待同步内容只有收到服务器确认后才算共享成功。更换连接后，请重开已有 AI 会话；网页访问仍需单独启用。</p>
  </section>
}
