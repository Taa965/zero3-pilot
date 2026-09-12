import { useEffect, useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { LocalSessionAdapter } from '../adapters/LocalSessionAdapter'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { Zero3SessionEventStore, type Zero3ProviderHandoff, type Zero3SessionEvent } from '../adapters/Zero3SessionEventStore'
import { Zero3NativeTimeline } from '../codex/Zero3NativeTimeline'
import type { LocalSessionRecord, LocalSessionThinkingEffort } from './session-types'
import { ProviderUsageBadge } from './ProviderUsageBadge'
import { localTurnFailureMessage } from './local-turn-failure'

type ApiProfile = Awaited<ReturnType<Window['zero3SessionProviders']['listZero3Profiles']>>[number]
type NativeModelCapability = {
  id: string
  model: string
  displayName: string
  isDefault: boolean
  defaultReasoningEffort: LocalSessionThinkingEffort | null
  supportedReasoningEfforts: Array<{ reasoningEffort: LocalSessionThinkingEffort; description: string }>
  serviceTiers: Array<{ id: string; name: string; description: string }>
  defaultServiceTier: string | null
}

type SharedMemoryBridge = {
  read: (request: { projectId: string }) => Promise<unknown>
  flush?: (request: { projectId: string }) => Promise<unknown>
  publishSessionContext?: (request: { projectId: string; logicalSessionId: string; startSeq: number; endSeq: number; events: Array<Record<string, unknown>> }) => Promise<unknown>
}

type Zero3Window = Window & { zero3SharedMemory?: SharedMemoryBridge }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function effort(value: LocalSessionThinkingEffort | null): LocalSessionThinkingEffort | null {
  return value && ['minimal','low','medium','high','xhigh','max','ultra'].includes(value) ? value : null
}
function parseNativeModelCapabilities(value: unknown): NativeModelCapability[] {
  const root = record(value)
  const data = Array.isArray(root.data) ? root.data.map(record) : []
  const allowedEfforts = new Set<LocalSessionThinkingEffort>(['minimal','low','medium','high','xhigh','max','ultra'])
  return data.flatMap(item => {
    const id = string(item.id) || string(item.model)
    const model = string(item.model) || id
    if (!id || !model || item.hidden === true) return []
    const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map(record).flatMap(raw => {
      const candidate = string(raw.reasoningEffort) as LocalSessionThinkingEffort
      return allowedEfforts.has(candidate) ? [{ reasoningEffort: candidate, description: string(raw.description) }] : []
    }) : []
    const tiers = Array.isArray(item.serviceTiers) ? item.serviceTiers.map(record).flatMap(raw => {
      const tierId = string(raw.id)
      return tierId ? [{ id: tierId, name: string(raw.name) || tierId, description: string(raw.description) }] : []
    }) : []
    const defaultEffort = string(item.defaultReasoningEffort) as LocalSessionThinkingEffort
    return [{ id, model, displayName: string(item.displayName) || model, isDefault: item.isDefault === true,
      defaultReasoningEffort: allowedEfforts.has(defaultEffort) ? defaultEffort : null,
      supportedReasoningEfforts: efforts, serviceTiers: tiers,
      defaultServiceTier: string(item.defaultServiceTier) || null }]
  })
}

function profileDescriptor(profile: ApiProfile | undefined, fallbackId: string | null, model: string | null, serviceTier: string | null, threadId: string | null) {
  return {
    profileId: profile?.id ?? fallbackId,
    name: profile?.name ?? fallbackId,
    protocol: profile?.protocol ?? null,
    baseUrl: profile?.baseUrl ?? null,
    model: model ?? profile?.model ?? null,
    serviceTier,
    runtimeThreadId: threadId
  }
}
async function listNativeModelCapabilities(): Promise<NativeModelCapability[]> {
  if (typeof window.zero3Codex?.model?.list !== 'function') return []
  const result: NativeModelCapability[] = []
  let cursor: string | undefined
  for (let page = 0; page < 5; page += 1) {
    const response = await window.zero3Codex.model.list({ includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) })
    result.push(...parseNativeModelCapabilities(response))
    const next = string(record(response).nextCursor)
    if (!next) break
    cursor = next
  }
  return result
}

async function sharedMemoryHandoff(projectId: string, logicalSessionId: string): Promise<Record<string, unknown>> {
  const bridge = (window as Zero3Window).zero3SharedMemory
  const locator = `zero3-shared-memory://${projectId}`
  const ackedRefs: string[] = []
  if (!bridge) return { locator, status: 'unconfigured', project_sequence: 0, task_sequence: 0, authority_refs: [], retrieval_refs: [] }
  try {
    if (bridge.flush) await bridge.flush({ projectId })
    if (bridge.publishSessionContext) {
      for (const batch of Zero3SessionEventStore.transferBatches(logicalSessionId)) {
        const published = record(await bridge.publishSessionContext({ projectId, logicalSessionId, startSeq: batch.startSeq, endSeq: batch.endSeq, events: batch.events }))
        const result = record(published.result)
        if (published.mode === 'shared' && result.state === 'acked') {
          Zero3SessionEventStore.markCoveredRange(logicalSessionId, batch.startSeq, batch.endSeq)
          if (typeof result.entity_id === 'string') ackedRefs.push(result.entity_id)
        }
      }
    }
    if (bridge.flush) await bridge.flush({ projectId })
    const raw = record(await bridge.read({ projectId }))
    if (raw.mode !== 'shared') return { locator, status: 'unconfigured', project_sequence: 0, task_sequence: 0, authority_refs: [], retrieval_refs: ackedRefs }
    const context = record(raw.context)
    const sync = record(context.sync)
    const entities = Array.isArray(context.entities) ? context.entities.map(record) : []
    const sequence = typeof sync.last_sequence === 'number' ? sync.last_sequence : typeof context.version === 'number' ? context.version : 0
    return { locator, status: raw.error ? 'unavailable' : sync.stale === true ? 'stale' : 'ready', project_sequence: sequence, task_sequence: 0, context_version: typeof context.version === 'number' ? context.version : 0, authority_refs: entities.filter(item => typeof item.entity_id === 'string').slice(-100).map(item => item.entity_id), retrieval_refs: ackedRefs }
  } catch (error) {
    return { locator, status: 'unavailable', project_sequence: 0, task_sequence: 0, authority_refs: [], retrieval_refs: ackedRefs, error: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForSwitchWriter(logicalSessionId: string, switchToken: string) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const status = await window.zero3SessionProviders.zero3ProviderSwitchStatus({ logicalSessionId })
    if (!status || status.switchToken !== switchToken) throw new Error('Provider switch token expired')
    if (!status.activeWriter) return status
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('等待当前 Turn 完成超时')
}

async function runZero3Turn(session: LocalSessionRecord, project: Zero3ProjectRecord, prompt: string, requestId: string) {
  if (!session.zero3ProfileId) throw new Error('该 Zero3 会话没有绑定 API Profile')
  const runtime = Zero3SessionEventStore.snapshot(session.id)
  const pendingHandoff = runtime.pendingHandoff
  const recoveryHandoff = pendingHandoff || !session.runtimeId ? null : Zero3SessionEventStore.buildRecoveryHandoff(session.id)
  const migrationHistory = session.runtimeId ? [] : session.messages.slice(0, -1).map(message => ({ role: message.role, content: message.content }))
  const result = await window.zero3SessionProviders.zero3Turn({
    profileId: session.zero3ProfileId,
    logicalSessionId: session.id,
    generation: runtime.binding.generation,
    requestId,
    text: prompt,
    cwd: project.rootPath,
    projectId: project.id,
    threadId: session.runtimeId,
    model: session.model,
    effort: effort(session.thinkingEffort),
    serviceTier: session.serviceTier,
    handoff: pendingHandoff,
    allowRuntimeRotation: Boolean(pendingHandoff),
    recoveryHandoff,
    allowRuntimeRecovery: Boolean(recoveryHandoff),
    history: migrationHistory
  })
  if (result.threadId && result.threadId !== session.runtimeId) LocalSessionAdapter.setRuntimeId(session.id, result.threadId)
  Zero3SessionEventStore.setRuntimeThread(session.id, result.threadId)
  if (pendingHandoff) Zero3SessionEventStore.completeProviderSwitch(session.id)
  return result
}
interface Props {
  session: LocalSessionRecord | null
  project: Zero3ProjectRecord | null
  onChanged: () => void
  onExecutionChange: (sessionId: string, executing: boolean) => void
}

export function Zero3NativeConversationSurface({ session, project, onChanged, onExecutionChange }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [events, setEvents] = useState<Zero3SessionEvent[]>([])
  const [profiles, setProfiles] = useState<ApiProfile[]>([])
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [nativeModels, setNativeModels] = useState<NativeModelCapability[]>([])
  const [modelDraft, setModelDraft] = useState('')
  const [effortDraft, setEffortDraft] = useState<LocalSessionThinkingEffort | ''>('')
  const [serviceTierDraft, setServiceTierDraft] = useState('')
  const [restoredSessionId, setRestoredSessionId] = useState<string | null>(null)

  useEffect(() => {
    if (!session) { setEvents([]); setRestoredSessionId(null); return }
    let cancelled = false
    setRestoredSessionId(null)
    const unsubscribe = Zero3SessionEventStore.subscribe(session.id, () => {
      if (!cancelled) setEvents(Zero3SessionEventStore.events(session.id))
    })
    void (async () => {
      try { await Zero3SessionEventStore.restorePersisted(session.id) }
      catch (restoreError) {
        if (!cancelled) setNotice(`会话持久化恢复失败，已使用本地缓存：${localTurnFailureMessage(restoreError)}`)
      }
      if (cancelled) return
      const state = Zero3SessionEventStore.ensureMigrated(session)
      Zero3SessionEventStore.setBinding(session.id, {
        profileId: session.zero3ProfileId, model: session.model, thinkingEffort: session.thinkingEffort, serviceTier: session.serviceTier,
        runtimeThreadId: session.runtimeId, projectId: session.projectId
      })
      setEvents(state.events)
      setModelDraft(session.model ?? '')
      setEffortDraft(session.thinkingEffort ?? '')
      setServiceTierDraft(session.serviceTier ?? '')
      setError(null)
      setRestoredSessionId(session.id)
      if (session.runtimeId && typeof window.zero3Codex?.thread?.read === 'function') {
        void window.zero3Codex.thread.read({ threadId: session.runtimeId, includeTurns: true }).then(read => {
          Zero3SessionEventStore.hydrateFromThread(session.id, read, session.runtimeId)
        }).catch(() => {})
      }
    })()
    return () => { cancelled = true; unsubscribe() }
  }, [session?.id])
  useEffect(() => {
    if (!session || restoredSessionId !== session.id) return
    setModelDraft(session.model ?? '')
    setEffortDraft(session.thinkingEffort ?? '')
    setServiceTierDraft(session.serviceTier ?? '')
    Zero3SessionEventStore.setBinding(session.id, {
      profileId: session.zero3ProfileId, model: session.model, thinkingEffort: session.thinkingEffort,
      runtimeThreadId: session.runtimeId, projectId: session.projectId
    })
  }, [session?.updatedAt, restoredSessionId])

  useEffect(() => {
    if (!session || typeof window.zero3SessionProviders?.onZero3Event !== 'function') return
    return window.zero3SessionProviders.onZero3Event(payload => {
      if (payload.logicalSessionId !== session.id) return
      const current = Zero3SessionEventStore.snapshot(session.id)
      if (payload.generation !== current.binding.generation) return
      Zero3SessionEventStore.ingestCodexEvent(session.id, payload.event)
    })
  }, [session?.id])

  useEffect(() => {
    let cancelled = false
    void window.zero3SessionProviders.listZero3Profiles().then(items => { if (!cancelled) setProfiles(items) }).catch(error => {
      if (!cancelled) setError(localTurnFailureMessage(error))
    })
    return () => { cancelled = true }
  }, [session?.id])

  useEffect(() => {
    let cancelled = false
    void listNativeModelCapabilities().then(items => { if (!cancelled) setNativeModels(items) }).catch(() => {
      if (!cancelled) setNativeModels([])
    })
    return () => { cancelled = true }
  }, [session?.id])

  useEffect(() => {
    if (!session?.zero3ProfileId) { setModelOptions([]); return }
    let cancelled = false
    void window.zero3SessionProviders.listZero3Models({ profileId: session.zero3ProfileId }).then(result => {
      if (!cancelled) setModelOptions(result.models)
    }).catch(() => {
      const profile = profiles.find(item => item.id === session.zero3ProfileId)
      if (!cancelled) setModelOptions(profile ? [profile.model] : [])
    })
    return () => { cancelled = true }
  }, [profiles, session?.zero3ProfileId])
  const currentProfile = useMemo(() => profiles.find(profile => profile.id === session?.zero3ProfileId), [profiles, session?.zero3ProfileId])
  const currentNativeModel = useMemo(() => {
    const selected = modelDraft.trim() || session?.model || currentProfile?.model || ''
    return nativeModels.find(item => item.model === selected || item.id === selected)
  }, [currentProfile?.model, modelDraft, nativeModels, session?.model])
  const effortOptions = currentNativeModel?.supportedReasoningEfforts.length
    ? currentNativeModel.supportedReasoningEfforts
    : (['minimal','low','medium','high','xhigh','max','ultra'] as LocalSessionThinkingEffort[]).map(reasoningEffort => ({ reasoningEffort, description: '' }))
  const serviceTierOptions = currentNativeModel?.serviceTiers ?? []
  useEffect(() => {
    if (!currentNativeModel) return
    const supported = currentNativeModel.supportedReasoningEfforts.map(item => item.reasoningEffort)
    if (supported.length && (!effortDraft || !supported.includes(effortDraft))) {
      setEffortDraft(currentNativeModel.defaultReasoningEffort ?? supported[0] ?? '')
    }
    const tierIds = currentNativeModel.serviceTiers.map(item => item.id)
    if (tierIds.length && (!serviceTierDraft || !tierIds.includes(serviceTierDraft))) {
      setServiceTierDraft(currentNativeModel.defaultServiceTier ?? tierIds[0] ?? '')
    } else if (!tierIds.length && serviceTierDraft) {
      setServiceTierDraft('')
    }
  }, [currentNativeModel?.id])

  const canSend = Boolean(session && restoredSessionId === session.id && project && session.zero3ProfileId && input.trim() && !busy && !switching && !['HANDOFF_PENDING','HANDOFF_VERIFYING'].includes(Zero3SessionEventStore.switchState(session.id).phase))

  const switchProfile = async (profileId: string) => {
    if (!session || !project || switching || profileId === session.zero3ProfileId) return
    const next = profiles.find(profile => profile.id === profileId)
    if (!next) { setError('目标 API Profile 不存在'); return }
    setSwitching(true)
    setError(null)
    let switchToken: string | null = null
    try {
      const runtime = Zero3SessionEventStore.snapshot(session.id)
      const begun = await window.zero3SessionProviders.beginZero3ProviderSwitch({ logicalSessionId: session.id, sourceGeneration: runtime.binding.generation, sourceProfileId: session.zero3ProfileId, targetProfileId: next.id, projectId: project.id })
      switchToken = begun.switchToken
      if (!switchToken || begun.targetGeneration == null) throw new Error('Provider switch 未返回有效 token/generation')
      Zero3SessionEventStore.beginProviderSwitch(session.id, { token: switchToken, targetGeneration: begun.targetGeneration, targetProfileId: next.id })
      if (begun.activeWriter) await waitForSwitchWriter(session.id, switchToken)
      Zero3SessionEventStore.markProviderSwitchVerifying(session.id, switchToken)
      const sharedMemory = await sharedMemoryHandoff(project.id, session.id)
      const memoryReady = sharedMemory.status === 'ready'
      const handoff = Zero3SessionEventStore.buildProviderHandoff(session.id, {
        projectId: project.id,
        fromProfile: profileDescriptor(currentProfile, session.zero3ProfileId, session.model, session.serviceTier, session.runtimeId),
        toProfile: profileDescriptor(next, next.id, next.model, null, session.runtimeId),
        sharedMemory,
        includeCoveredEvents: !memoryReady
      })
      await window.zero3SessionProviders.verifyZero3ProviderSwitch({ logicalSessionId: session.id, switchToken, handoff })
      const targetNativeModel = nativeModels.find(item => item.model === next.model || item.id === next.model)
      const supportedEfforts = targetNativeModel?.supportedReasoningEfforts.map(item => item.reasoningEffort) ?? []
      const targetEffort = effortDraft && (!supportedEfforts.length || supportedEfforts.includes(effortDraft))
        ? effortDraft : targetNativeModel?.defaultReasoningEffort ?? session.thinkingEffort
      const targetServiceTier = targetNativeModel?.defaultServiceTier ?? null
      LocalSessionAdapter.setZero3RuntimeConfig(session.id, { profileId: next.id, model: next.model, thinkingEffort: targetEffort, serviceTier: targetServiceTier })
      Zero3SessionEventStore.stageProviderSwitch(session.id, handoff, { profileId: next.id, model: next.model, thinkingEffort: targetEffort, serviceTier: targetServiceTier, projectId: project.id })
      setModelDraft(next.model)
      setEffortDraft(targetEffort ?? '')
      setServiceTierDraft(targetServiceTier ?? '')
      setNotice('Provider switch handoff verified; the next Turn will activate the target Provider.')
      onChanged()
    } catch (nextError) {
      const message = localTurnFailureMessage(nextError)
      if (switchToken) {
        try { await window.zero3SessionProviders.failZero3ProviderSwitch({ logicalSessionId: session.id, switchToken, error: message }) } catch {}
        Zero3SessionEventStore.failProviderSwitch(session.id, switchToken, message)
      }
      setError(message)
    } finally {
      setSwitching(false)
    }
  }

  const applyRuntimeConfig = () => {
    if (!session?.zero3ProfileId) return
    const model = modelDraft.trim() || currentProfile?.model || null
    const nextEffort = effortDraft || currentNativeModel?.defaultReasoningEffort || null
    const nextServiceTier = serviceTierDraft || currentNativeModel?.defaultServiceTier || null
    LocalSessionAdapter.setZero3RuntimeConfig(session.id, { profileId: session.zero3ProfileId, model, thinkingEffort: nextEffort, serviceTier: nextServiceTier })
    Zero3SessionEventStore.setBinding(session.id, { profileId: session.zero3ProfileId, model, thinkingEffort: nextEffort, serviceTier: nextServiceTier })
    setNotice(`后续 Turn 将使用 ${model ?? 'Provider 默认模型'}${nextEffort ? ` · ${nextEffort}` : ''}${nextServiceTier ? ` · ${nextServiceTier}` : ''}。`)
    onChanged()
  }
  const send = async () => {
    if (!session || !project || !canSend) return
    const prompt = input.trim()
    const requestId = crypto.randomUUID()
    setInput('')
    setBusy(true)
    setError(null)
    onExecutionChange(session.id, true)
    try {
      const latest = LocalSessionAdapter.get(session.id) ?? session
      const withUser = LocalSessionAdapter.appendMessage(latest.id, 'user', prompt)
      Zero3SessionEventStore.appendUser(session.id, prompt, { profileId: withUser.zero3ProfileId ?? undefined, runtimeThreadId: withUser.runtimeId ?? undefined })
      Zero3SessionEventStore.setBinding(session.id, {
        profileId: withUser.zero3ProfileId, model: withUser.model, thinkingEffort: withUser.thinkingEffort, serviceTier: withUser.serviceTier,
        runtimeThreadId: withUser.runtimeId, projectId: project.id
      })
      const result = await runZero3Turn(withUser, project, prompt, requestId)
      const withAssistant = LocalSessionAdapter.appendMessage(session.id, 'assistant', result.text)
      Zero3SessionEventStore.appendAssistant(session.id, result.text, { profileId: result.profileId, runtimeThreadId: result.threadId })
      if (result.runtimeRotated) setNotice('目标 API 服务商无法安全复用原 Runtime Thread；Zero3 已在同一个逻辑会话内完成 Runtime Thread 轮换。')
      setEvents(Zero3SessionEventStore.events(session.id))
      onChanged()
      void withAssistant
    } catch (nextError) {
      const message = localTurnFailureMessage(nextError)
      const switchState = Zero3SessionEventStore.switchState(session.id)
      if (switchState.phase === 'SWITCHING') {
        Zero3SessionEventStore.failProviderSwitch(session.id, switchState.token, message)
        try { await window.zero3SessionProviders.failZero3ProviderSwitch({ logicalSessionId: session.id, switchToken: switchState.token, error: message }) } catch {}
      }
      setError(message)
      try {
        LocalSessionAdapter.appendMessage(session.id, 'assistant', `执行失败：${message}`)
        Zero3SessionEventStore.appendAssistant(session.id, `执行失败：${message}`)
        onChanged()
      } catch {}
    } finally {
      onExecutionChange(session.id, false)
      setBusy(false)
    }
  }

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-(--ui-text-secondary)">
        <Codicon name="hubot" className="mb-4 size-12 opacity-40" />
        <div>从左侧选择一个 Zero3 本体会话</div>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-(--ui-border) px-4 py-2">
        <div className="font-medium">Zero3 本体</div>
        <div className="min-w-0 flex-1 truncate text-xs text-(--ui-text-tertiary)">
          {currentProfile ? `${currentProfile.name} · ${session.model ?? currentProfile.model}${session.thinkingEffort ? ` · ${session.thinkingEffort}` : ''}${session.serviceTier ? ` · ${session.serviceTier}` : ''}` : '未绑定 API Profile'}
          {session.runtimeId ? ` · Runtime ${session.runtimeId}` : ''}
        </div>
        <ProviderUsageBadge provider="zero3" profileId={session.zero3ProfileId} refreshToken={session.updatedAt} />
        {project && <div className="max-w-48 truncate rounded bg-(--ui-control-background) px-2 py-1 text-xs text-(--ui-text-secondary)">{project.name}</div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Zero3NativeTimeline events={events} />
        {busy && events.at(-1)?.type === 'userMessage' && (
          <div className="mt-4 flex items-center gap-2 text-xs text-(--ui-text-tertiary)">
            <span className="size-2 animate-pulse rounded-full bg-blue-500" />
            正在启动 Zero3 Codex Agent Kernel…
          </div>
        )}
        {error && <div role="alert" className="mt-4 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</div>}
        {notice && <div role="status" className="mt-3 text-xs text-(--ui-text-secondary)">{notice}</div>}
      </div>

      <div className="shrink-0 border-t border-(--ui-border) p-4">
        {!project && <div className="mb-2 text-xs text-amber-600">Zero3 本体需要绑定项目目录，才能提供文件、终端与工具能力。</div>}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="API 服务商"
            value={session.zero3ProfileId ?? ''}
            disabled={switching}
            onChange={event => void switchProfile(event.target.value)}
            className="h-8 max-w-52 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-xs"
          >
            <option value="">选择 API Profile</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>          <input
            aria-label="模型"
            list={`zero3-native-models-${session.id}`}
            value={modelDraft}
            disabled={busy || switching || !session.zero3ProfileId}
            onChange={event => setModelDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyRuntimeConfig() } }}
            className="h-8 min-w-44 flex-1 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-xs"
            placeholder={currentProfile?.model ?? 'Model'}
          />
          <datalist id={`zero3-native-models-${session.id}`}>
            {[...new Set([session.model, currentProfile?.model, ...modelOptions].filter((value): value is string => Boolean(value)))].map(model => <option key={model} value={model} />)}
          </datalist>
          <select
            aria-label="思考强度"
            value={effortDraft}
            disabled={busy || switching}
            onChange={event => setEffortDraft(event.target.value as LocalSessionThinkingEffort | '')}
            className="h-8 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-xs"
          >
            <option value="">{currentNativeModel?.defaultReasoningEffort ? `默认 · ${currentNativeModel.defaultReasoningEffort}` : '默认思考'}</option>
            {effortOptions.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
          </select>
          {serviceTierOptions.length > 0 && (
            <select aria-label="服务档位" value={serviceTierDraft} disabled={busy || switching}
              onChange={event => setServiceTierDraft(event.target.value)}
              className="h-8 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-xs">
              <option value="">{currentNativeModel?.defaultServiceTier ? `默认 · ${currentNativeModel.defaultServiceTier}` : '默认档位'}</option>
              {serviceTierOptions.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
            </select>
          )}
          <button
            type="button"
            disabled={busy || switching || !session.zero3ProfileId}
            onClick={applyRuntimeConfig}
            className="h-8 rounded-md border border-(--ui-border) px-2 text-xs hover:bg-(--ui-control-hover-background) disabled:opacity-40"
          >
            应用
          </button>
          {switching && <span className="text-xs text-(--ui-text-tertiary)">正在生成 Provider Handoff…</span>}
        </div>

        <div className="relative">
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            disabled={busy || switching}
            placeholder="给 Zero3 本体发送消息…"
            className="min-h-[92px] w-full resize-none rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3 pr-14 text-sm outline-none focus:border-blue-500 disabled:opacity-60"
          />          <button
            disabled={!canSend}
            onClick={() => void send()}
            className="absolute bottom-3 right-3 rounded-md bg-blue-600 p-2 text-white disabled:opacity-40"
            aria-label="发送"
          >
            <Codicon name="send" className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
