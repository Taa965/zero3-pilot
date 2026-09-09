import type { WorkspaceProvider } from './session-types'

type StatusMap = Awaited<ReturnType<Window['zero3SessionProviders']['status']>>
type ProviderStatus = NonNullable<StatusMap[WorkspaceProvider]>
export type CliProvider = 'codex' | 'claude' | 'antigravity'
const CLI_PROVIDERS: CliProvider[] = ['codex', 'claude', 'antigravity']
const STORAGE_KEY = 'zero3.global-cli-readiness.v1'

export function isCliProvider(provider: string): provider is CliProvider {
  return CLI_PROVIDERS.includes(provider as CliProvider)
}

// Persist only readiness flags, never credentials or CLI output. Failed probes
// live in memory until retry; successful connections survive dialog/app restarts.
export function createProviderReadiness(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  probe: (provider: CliProvider) => Promise<StatusMap>
) {
  const ready = (): ProviderStatus => ({ available: true, authenticated: true, authMode: 'cli', detail: '已连接；可直接创建会话' })
  let snapshot: { statuses: StatusMap; checking: Partial<Record<CliProvider, boolean>> } = {
    statuses: {
      gpt: { available: true, authenticated: null, authMode: 'web', detail: '使用官方网页登录' },
      gemini: { available: true, authenticated: null, authMode: 'web', detail: '使用官方网页登录' }
    },
    checking: {}
  }
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}')
    for (const provider of CLI_PROVIDERS) {
      if (saved?.[provider] === true) snapshot.statuses[provider] = ready()
    }
  } catch { /* Storage may be unavailable or from an older version. */ }
  const listeners = new Set<() => void>()
  const pending = new Map<CliProvider, Promise<void>>()
  const revisions = new Map<CliProvider, number>()
  const publish = () => { for (const listener of listeners) listener() }
  const persist = () => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(CLI_PROVIDERS.map(provider => [
        provider, snapshot.statuses[provider]?.available === true && snapshot.statuses[provider]?.authenticated === true
      ]))))
    } catch { /* Keep the in-memory cache usable. */ }
  }
  const change = (provider: CliProvider, value?: ProviderStatus) => {
    revisions.set(provider, (revisions.get(provider) ?? 0) + 1)
    snapshot = { ...snapshot, statuses: { ...snapshot.statuses, [provider]: value } }
    persist()
    publish()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    markReady(provider: string) { if (isCliProvider(provider)) change(provider, ready()) },
    invalidate(provider: string) { if (isCliProvider(provider)) change(provider) },
    async ensure(provider: CliProvider, force = false): Promise<void> {
      if (pending.has(provider)) return pending.get(provider)
      if (!force && snapshot.statuses[provider]) return
      const revision = revisions.get(provider) ?? 0
      snapshot = { ...snapshot, checking: { ...snapshot.checking, [provider]: true } }
      // Defer the probe until pending is registered, including synchronous errors.
      const work = Promise.resolve().then(async () => {
        let value: ProviderStatus
        try {
          const result = await probe(provider)
          if (!result[provider]) throw new Error('未收到平台检测结果，请重试')
          value = result[provider]!
        } catch (error) {
          value = { available: null, authenticated: null, authMode: 'cli', detail: error instanceof Error ? error.message : String(error) }
        }
        // A successful turn or invalidation is newer evidence than this probe.
        if ((revisions.get(provider) ?? 0) === revision) change(provider, value)
      }).finally(() => {
        pending.delete(provider)
        snapshot = { ...snapshot, checking: { ...snapshot.checking, [provider]: false } }
        publish()
      })
      pending.set(provider, work)
      publish()
      return work
    }
  }
}

export const providerReadiness = createProviderReadiness({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value)
}, provider => window.zero3SessionProviders.status({ provider }))
