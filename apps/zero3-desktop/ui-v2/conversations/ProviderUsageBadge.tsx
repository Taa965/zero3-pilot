import { useEffect, useRef, useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import type { LocalSessionProvider } from './session-types'

type Usage = Awaited<ReturnType<Window['zero3SessionProviders']['usage']>>
const snapshots = new Map<string, Usage>()
const pending = new Map<string, Promise<Usage>>()

function query(provider: LocalSessionProvider, profileId: string | null, force: boolean) {
  const key = JSON.stringify([provider, profileId])
  if (pending.has(key)) return pending.get(key)!
  const work = window.zero3SessionProviders.usage({ provider, profileId, force }).then(value => {
    snapshots.set(key, value)
    if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value!)
    return value
  }).finally(() => pending.delete(key))
  pending.set(key, work)
  return work
}

export function ProviderUsageBadge({ provider, profileId, refreshToken }: {
  provider: LocalSessionProvider
  profileId: string | null
  refreshToken?: string
}) {
  const key = JSON.stringify([provider, profileId])
  const [state, setState] = useState<{ key: string; value?: Usage }>({ key, value: snapshots.get(key) })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const manualRefresh = useRef(false)
  const value = state.key === key ? state.value : snapshots.get(key)

  useEffect(() => {
    let active = true
    const update = async (force = false) => {
      if (typeof window.zero3SessionProviders?.usage !== 'function') {
        setError('请重载 Zero3 以启用额度查询')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const next = await query(provider, profileId, force)
        if (active) setState({ key, value: next })
      } catch {
        if (active) setError('额度暂不可获取，请稍后刷新')
      } finally { if (active) setLoading(false) }
    }
    const force = manualRefresh.current
    manualRefresh.current = false
    void update(force)
    const timer = setInterval(() => { if (!document.hidden) void update() }, 300_000)
    return () => { active = false; clearInterval(timer) }
  }, [key, provider, profileId, refreshToken, refresh])

  const percent = (window: Usage['fiveHour'] | undefined) => {
    if (error || window?.remainingPercent == null) return loading && !value ? '读取中' : '暂不可获取'
    return `${Math.floor(window.remainingPercent)}%`
  }
  const resetTime = (window: Usage['fiveHour'] | undefined) => window?.resetsAt ? new Date(window.resetsAt).toLocaleString() : '未提供'
  const title = error ?? (value ? [value.detail,
    ...(provider === 'zero3' ? [] : [`5 小时额度恢复：${resetTime(value.fiveHour)}`, `周额度恢复：${resetTime(value.weekly)}`]),
    `查询时间：${new Date(value.checkedAt).toLocaleString()}`
  ].join('\n') : '正在读取额度')
  const balance = error || !value?.balances.length ? loading && !value ? '读取中' : '暂不可获取'
    : value.balances.map(item => `${item.currency} ${item.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`).join(' / ')
  const low = !error && (provider === 'zero3' ? value?.balances.some(item => item.amount <= 0)
    : [value?.fiveHour.remainingPercent, value?.weekly.remainingPercent].some(item => item != null && item <= 10))

  return (
    <div aria-label="账户剩余额度" className={`ml-auto flex shrink-0 items-center gap-2 rounded-md border px-2 py-1 text-xs ${low ? 'border-amber-500/40 text-amber-700 dark:text-amber-400' : 'border-(--ui-border) text-(--ui-text-secondary)'}`} title={title}>
      {provider === 'zero3' ? <span>API 余额：{balance}</span> : <>
        <span>本周剩余：{percent(value?.weekly)}</span>
        <span className="text-(--ui-text-tertiary)">·</span>
        <span>5 小时剩余：{percent(value?.fiveHour)}</span>
      </>}
      <button type="button" disabled={loading} onClick={() => { manualRefresh.current = true; setRefresh(current => current + 1) }} aria-label="刷新额度" title={loading ? '正在刷新额度' : '刷新额度（查询间隔至少 30 秒）'} className="rounded p-0.5 hover:bg-(--ui-control-hover-background) disabled:opacity-40">
        <Codicon name="refresh" className={`size-3 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>
  )
}
