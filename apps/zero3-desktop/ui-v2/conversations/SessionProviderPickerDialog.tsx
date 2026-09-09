import { useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { LocalSessionRuntimeConfig, LocalSessionThinkingEffort, WorkspaceProvider } from './session-types'

type StatusMap = Awaited<ReturnType<Window['zero3SessionProviders']['status']>>
type ApiProfile = Awaited<ReturnType<Window['zero3SessionProviders']['listZero3Profiles']>>[number]
type ApiProtocol = ApiProfile['protocol']

interface SessionProviderPickerDialogProps {
  project: Zero3ProjectRecord | null
  onCreate: (provider: WorkspaceProvider, options?: LocalSessionRuntimeConfig & { zero3ProfileId?: string | null }) => void
  onCancel: () => void
}

type RuntimeProvider = Extract<WorkspaceProvider, 'codex' | 'claude' | 'antigravity'>
type RuntimeDraft = {
  model: string
  thinkingEffort: LocalSessionThinkingEffort | ''
}

const MODEL_SUGGESTIONS: Record<RuntimeProvider, Array<{ value: string; label: string }>> = {
  // Availability depends on the CLI's account and provider. A static list was
  // offering rejected models; leave blank to inherit the user's working CLI.
  codex: [],
  claude: [
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
  ],
  antigravity: []
}

const EFFORT_OPTIONS: Record<RuntimeProvider, Array<{ value: LocalSessionThinkingEffort; label: string }>> = {
  codex: [
    { value: 'low', label: '低（Low）' },
    { value: 'medium', label: '中（Medium）' },
    { value: 'high', label: '高（High）' },
    { value: 'xhigh', label: '超高（XHigh）' }
  ],
  claude: [
    { value: 'low', label: '低（Low）' },
    { value: 'medium', label: '中（Medium）' },
    { value: 'high', label: '高（High）' },
    { value: 'xhigh', label: '超高（XHigh）' },
    { value: 'max', label: '最大（Max）' }
  ],
  antigravity: [
    { value: 'low', label: '低（Low）' },
    { value: 'medium', label: '中（Medium）' },
    { value: 'high', label: '高（High）' }
  ]
}

function isRuntimeProvider(provider: WorkspaceProvider): provider is RuntimeProvider {
  return provider === 'codex' || provider === 'claude' || provider === 'antigravity'
}

const PROVIDERS: Array<{
  id: WorkspaceProvider
  title: string
  icon: string
  description: string
  requiresProject?: boolean
}> = [
  { id: 'gpt', title: 'ChatGPT 网页', icon: 'globe', description: '内嵌 chatgpt.com，直接使用网页账号与订阅。' },
  { id: 'gemini', title: 'Gemini 网页', icon: 'globe', description: '内嵌 gemini.google.com，直接使用 Google 网页账号。' },
  { id: 'codex', title: '本地 Codex', icon: 'terminal', description: '调用本机官方 Codex 客户端（codex exec），复用它的 ChatGPT 登录。', requiresProject: true },
  { id: 'claude', title: 'Claude Code', icon: 'terminal', description: '调用本机 Claude Code CLI，复用官方 Claude 登录。', requiresProject: true },
  { id: 'antigravity', title: 'Antigravity', icon: 'rocket', description: '调用本机官方 agy CLI，并保留 Antigravity 会话绑定。', requiresProject: true },
  { id: 'zero3', title: 'Zero3 本体', icon: 'hubot', description: '使用你配置的 API 模型驱动 Zero3 的 Codex Agent Kernel，保留项目文件、终端与工具能力。', requiresProject: true }
]

const PROTOCOL_DEFAULTS: Record<ApiProtocol, { baseUrl: string; model: string }> = {
  openai_compatible: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-6' },
  google_gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' }
}

function statusLabel(status: StatusMap[WorkspaceProvider] | undefined) {
  if (!status) return { text: '检测中', className: 'text-(--ui-text-tertiary)' }
  // A probe that timed out reports null, and that is not the same as missing.
  // Saying 未安装 for a CLI that is installed and merely slow is what sent this
  // dialog's users chasing an install problem that did not exist.
  if (status.available === null) return { text: '检测超时', className: 'text-amber-600' }
  if (!status.available) return { text: '未安装', className: 'text-red-600' }
  if (status.authenticated === false) return { text: '未授权', className: 'text-amber-600' }
  if (status.authenticated === true) return { text: '已就绪', className: 'text-green-600' }
  return { text: status.authMode === 'web' ? '网页登录' : '待检测', className: 'text-blue-600' }
}

function makeProfileId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `api-${random}`
}

export function SessionProviderPickerDialog({ project, onCreate, onCancel }: SessionProviderPickerDialogProps) {
  const [selected, setSelected] = useState<WorkspaceProvider>('gpt')
  const [status, setStatus] = useState<StatusMap | null>(null)
  const [profiles, setProfiles] = useState<ApiProfile[]>([])
  const [profileId, setProfileId] = useState('')
  const [profileName, setProfileName] = useState('OpenAI API')
  const [protocol, setProtocol] = useState<ApiProtocol>('openai_compatible')
  const [baseUrl, setBaseUrl] = useState(PROTOCOL_DEFAULTS.openai_compatible.baseUrl)
  const [model, setModel] = useState(PROTOCOL_DEFAULTS.openai_compatible.model)
  const [apiKey, setApiKey] = useState('')
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<RuntimeProvider, RuntimeDraft>>({
    codex: { model: '', thinkingEffort: '' },
    claude: { model: '', thinkingEffort: '' },
    antigravity: { model: '', thinkingEffort: '' }
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Each probe spawns a CLI, and focus fires more often than a person changes
  // windows. One refresh at a time keeps that from turning into a pile-up.
  const refreshing = useRef(false)
  const refresh = async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const [nextStatus, nextProfiles] = await Promise.all([
        window.zero3SessionProviders.status(),
        window.zero3SessionProviders.listZero3Profiles()
      ])
      setStatus(nextStatus)
      setProfiles(nextProfiles)
      setProfileId(current => current || nextProfiles[0]?.id || '')
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      refreshing.current = false
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Signing a CLI in happens in a terminal and a browser, so the answer changes
  // while this window is in the background. Re-probe when it comes back rather
  // than leaving the user to guess that the card needs clicking again.
  useEffect(() => {
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const profile = profiles.find(item => item.id === profileId)
    if (!profile) return
    setProfileName(profile.name)
    setProtocol(profile.protocol)
    setBaseUrl(profile.baseUrl)
    setModel(profile.model)
    setApiKey('')
  }, [profileId, profiles])

  const selectedStatus = status?.[selected]
  const selectedDefinition = PROVIDERS.find(provider => provider.id === selected)!
  const canCreate = useMemo(() => {
    if (busy) return false
    if (selectedDefinition.requiresProject && !project) return false
    if (selected === 'zero3') return Boolean(profileId)
    if (selected === 'gpt' || selected === 'gemini') return true
    return selectedStatus?.available === true && selectedStatus.authenticated !== false
  }, [busy, profileId, project, selected, selectedDefinition.requiresProject, selectedStatus])

  const authorize = async () => {
    setBusy(true)
    try {
      const result = await window.zero3SessionProviders.authorize({ provider: selected })
      setMessage(result.detail)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const saveProfile = async () => {
    setBusy(true)
    try {
      const id = profileId || makeProfileId()
      const saved = await window.zero3SessionProviders.saveZero3Profile({
        id,
        name: profileName,
        protocol,
        baseUrl,
        model,
        apiKey: apiKey || null
      })
      await refresh()
      setProfileId(saved.id)
      setApiKey('')
      setMessage(`已保存 API 模型：${saved.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const newProfile = () => {
    setProfileId('')
    setProfileName('自定义 API')
    setProtocol('openai_compatible')
    setBaseUrl(PROTOCOL_DEFAULTS.openai_compatible.baseUrl)
    setModel(PROTOCOL_DEFAULTS.openai_compatible.model)
    setApiKey('')
  }

  const removeProfile = async () => {
    if (!profileId) return
    setBusy(true)
    try {
      await window.zero3SessionProviders.removeZero3Profile({ id: profileId })
      setProfileId('')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const applyProtocol = (value: ApiProtocol) => {
    setProtocol(value)
    const defaults = PROTOCOL_DEFAULTS[value]
    setBaseUrl(defaults.baseUrl)
    setModel(defaults.model)
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-6" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-provider-picker-title"
        className="max-h-[88vh] w-[860px] max-w-[96vw] overflow-y-auto rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-5 shadow-md"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div id="session-provider-picker-title" className="text-lg font-semibold">新建会话</div>
            <div className="mt-1 text-xs text-(--ui-text-tertiary)">
              先选择运行平台。{project ? `当前项目：${project.name}` : '当前未选择项目。'}
            </div>
          </div>
          <button onClick={onCancel} className="rounded-md p-2 hover:bg-(--ui-control-hover-background)" aria-label="关闭">
            <Codicon name="close" className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {PROVIDERS.map(provider => {
            const itemStatus = status?.[provider.id]
            const badge = statusLabel(itemStatus)
            const disabledByProject = provider.requiresProject && !project
            // A provider that cannot be used says why on its own card. The
            // detail otherwise lives only in the panel below, one click away,
            // so an installed Antigravity IDE reads as a flat 未安装 with no
            // hint that the missing piece is the separate agy CLI. 待检测 needs
            // it just as much: an inconclusive probe is a dead end unless the
            // card says what the CLI actually did.
            const blockingDetail =
              itemStatus && !disabledByProject && itemStatus.authMode !== 'web' && itemStatus.authenticated !== true
                ? itemStatus.detail
                : null
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  setSelected(provider.id)
                  void refresh()
                }}
                className={`rounded-lg border p-3 text-left transition-colors ${selected === provider.id ? 'border-blue-500 bg-blue-500/5' : 'border-(--ui-border) hover:bg-(--ui-control-hover-background)'}`}
              >
                <div className="flex items-center gap-2">
                  <Codicon name={provider.icon} className="size-4" />
                  <span className="font-medium">{provider.title}</span>
                  <span className={`ml-auto text-[11px] ${disabledByProject ? 'text-amber-600' : badge.className}`}>
                    {disabledByProject ? '需要项目' : badge.text}
                  </span>
                </div>
                <div className="mt-2 text-xs leading-5 text-(--ui-text-tertiary)">{provider.description}</div>
                {blockingDetail && (
                  <div className={`mt-1.5 line-clamp-3 text-[11px] leading-4 ${badge.className}`} title={blockingDetail}>
                    {blockingDetail}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {selected !== 'zero3' && selectedStatus?.authMode === 'cli' && selectedStatus.authenticated !== true && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !selectedStatus.available}
              onClick={() => void authorize()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              打开官方 CLI 授权
            </button>
            <span className="text-xs text-(--ui-text-tertiary)">Zero3 不保存 Codex / Claude / Antigravity 的账号密码，只复用官方 CLI 登录。</span>
          </div>
        )}

        {isRuntimeProvider(selected) && (
          <div className="mt-4 rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-4">
            <div className="mb-3">
              <div className="text-sm font-medium">运行配置</div>
              <div className="mt-1 text-xs text-(--ui-text-tertiary)">
                留空会沿用官方 CLI 默认值；模型支持从常用项选择，也可以直接输入官方 CLI 支持的模型名。
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                模型
                <input
                  list={`zero3-${selected}-model-suggestions`}
                  value={runtimeDrafts[selected].model}
                  onChange={event => setRuntimeDrafts(current => ({
                    ...current,
                    [selected]: { ...current[selected], model: event.target.value }
                  }))}
                  placeholder={selected === 'antigravity' ? '官方默认；或输入 agy models 中的模型名' : '官方默认；或选择 / 输入模型名'}
                  className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground"
                />
                <datalist id={`zero3-${selected}-model-suggestions`}>
                  {MODEL_SUGGESTIONS[selected].map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </datalist>
              </label>
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                思考强度
                <select
                  value={runtimeDrafts[selected].thinkingEffort}
                  onChange={event => setRuntimeDrafts(current => ({
                    ...current,
                    [selected]: {
                      ...current[selected],
                      thinkingEffort: event.target.value as LocalSessionThinkingEffort | ''
                    }
                  }))}
                  className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground"
                >
                  <option value="">官方默认</option>
                  {EFFORT_OPTIONS[selected].map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-2 text-[11px] leading-5 text-(--ui-text-tertiary)">
              {selected === 'codex' && 'Codex 会把选择写入 --model 与 model_reasoning_effort，并在 resume 时继续覆盖。'}
              {selected === 'claude' && 'Claude Code 会通过 --model 与 --effort 执行；具体可用强度仍取决于所选 Claude 模型。'}
              {selected === 'antigravity' && 'Antigravity 当前官方 agy CLI 的 --effort 只支持 low / medium / high。'}
            </div>
          </div>
        )}

        {selected === 'zero3' && (
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <select
                value={profileId}
                onChange={event => setProfileId(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm"
              >
                <option value="">选择 API 模型配置…</option>
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>
                ))}
              </select>
              <button onClick={newProfile} className="rounded-md border border-(--ui-border) px-3 text-xs hover:bg-(--ui-control-hover-background)">新配置</button>
              {profileId && <button onClick={() => void removeProfile()} className="rounded-md border border-red-500/40 px-3 text-xs text-red-600">删除</button>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                配置名称
                <input value={profileName} onChange={event => setProfileName(event.target.value)} className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground" />
              </label>
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                API 协议
                <select value={protocol} onChange={event => applyProtocol(event.target.value as ApiProtocol)} className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground">
                  <option value="openai_compatible">OpenAI-Compatible</option>
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="google_gemini">Google Gemini API</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                Base URL
                <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground" />
              </label>
              <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
                Model
                <input value={model} onChange={event => setModel(event.target.value)} className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground" />
              </label>
            </div>
            <label className="grid gap-1 text-xs text-(--ui-text-tertiary)">
              API Key（留空会保留现有 Key；使用系统安全存储加密）
              <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} className="h-9 rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm text-foreground" />
            </label>
            <div className="flex items-center gap-2">
              <button onClick={() => void saveProfile()} disabled={busy || !profileName.trim() || !baseUrl.trim() || !model.trim()} className="rounded-md border border-(--ui-border) px-3 py-1.5 text-xs hover:bg-(--ui-control-hover-background) disabled:opacity-50">保存 API 配置</button>
              <span className="text-xs text-(--ui-text-tertiary)">DeepSeek / OpenRouter / GLM 等兼容接口请选择 OpenAI-Compatible 并填写对应 Base URL。</span>
            </div>
          </div>
        )}

        {selectedDefinition.requiresProject && !project && (
          <div className="mt-3 text-xs text-amber-600">该本地 Agent 会访问工作目录，请先在左上角选择或创建一个 Zero3 项目。</div>
        )}
        {message && <div className="mt-3 rounded-md bg-(--ui-control-background) px-3 py-2 text-xs text-(--ui-text-secondary)">{message}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-(--ui-border) px-4 py-2 text-sm hover:bg-(--ui-control-hover-background)">取消</button>
          <button
            disabled={!canCreate}
            onClick={() => {
              const runtime = isRuntimeProvider(selected) ? runtimeDrafts[selected] : null
              onCreate(selected, {
                zero3ProfileId: selected === 'zero3' ? profileId : null,
                model: runtime?.model.trim() || null,
                thinkingEffort: runtime?.thinkingEffort || null
              })
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            创建 {selectedDefinition.title} 会话
          </button>
        </div>
      </div>
    </div>
  )
}
