import { useCallback, useEffect, useMemo, useState } from 'react'

type RobotChannel = 'weixin' | 'qq'
type RobotBackend = 'zero3' | 'codex' | 'claude'

type ApiProfile = { id: string; name: string; model: string }
type ChannelSettings = { enabled: boolean; defaultBackend: RobotBackend; zero3ProfileId: string | null }
type RobotBridge = {
  weixinStatus: () => Promise<unknown>
  launchWeixinBinding: () => Promise<unknown>
  disconnectWeixin: () => Promise<unknown>
  startWeixin: () => Promise<unknown>
  stopWeixin: () => Promise<unknown>
  qqStatus: () => Promise<unknown>
  launchQqBinding: () => Promise<unknown>
  disconnectQq: () => Promise<unknown>
  startQq: () => Promise<unknown>
  stopQq: () => Promise<unknown>
  settings: () => Promise<unknown>
  setSettings: (request: Record<string, unknown>) => Promise<unknown>
}

type RobotViewState = {
  loading: boolean
  connected: boolean
  authorizationConfigured: boolean
  serviceRunning: boolean
  primaryId?: string
  ownerUserId?: string
  settings: ChannelSettings
  error?: string
  serviceError?: string
}

const DEFAULT_SETTINGS: ChannelSettings = { enabled: true, defaultBackend: 'zero3', zero3ProfileId: null }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function robotBridge(): RobotBridge | null {
  return (window as typeof window & { zero3Robots?: RobotBridge }).zero3Robots ?? null
}

function mask(value?: string): string {
  if (!value) return '—'
  return value.length <= 10 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`
}

function parseSettings(value: unknown): ChannelSettings {
  const item = record(value)
  const backend = item.defaultBackend
  return {
    enabled: item.enabled !== false,
    defaultBackend: backend === 'codex' || backend === 'claude' || backend === 'zero3' ? backend : 'zero3',
    zero3ProfileId: typeof item.zero3ProfileId === 'string' && item.zero3ProfileId.trim() ? item.zero3ProfileId.trim() : null
  }
}

function parseStatus(channel: RobotChannel, value: unknown): RobotViewState {
  const root = record(value)
  const platform = record(root[channel])
  const settings = parseSettings(root.settings)
  return {
    loading: false,
    connected: platform.connected === true,
    authorizationConfigured: root.authorization_configured === true,
    serviceRunning: root.service_running === true,
    serviceError: typeof root.service_error === 'string' && root.service_error.trim() ? root.service_error.trim() : undefined,
    primaryId: typeof (channel === 'weixin' ? platform.bot_id : platform.app_id) === 'string'
      ? String(channel === 'weixin' ? platform.bot_id : platform.app_id)
      : undefined,
    ownerUserId: typeof platform.owner_user_id === 'string' ? platform.owner_user_id : undefined,
    settings
  }
}

function parseProfiles(value: unknown): ApiProfile[] {
  const root = record(value)
  if (!Array.isArray(root.profiles)) return []
  return root.profiles.map(record).flatMap(item => {
    const id = typeof item.id === 'string' ? item.id : ''
    const name = typeof item.name === 'string' ? item.name : id
    const model = typeof item.model === 'string' ? item.model : ''
    return id ? [{ id, name, model }] : []
  })
}

function channelActions(bridge: RobotBridge, channel: RobotChannel) {
  return channel === 'weixin'
    ? {
        status: bridge.weixinStatus,
        bind: bridge.launchWeixinBinding,
        disconnect: bridge.disconnectWeixin,
        start: bridge.startWeixin,
        stop: bridge.stopWeixin
      }
    : {
        status: bridge.qqStatus,
        bind: bridge.launchQqBinding,
        disconnect: bridge.disconnectQq,
        start: bridge.startQq,
        stop: bridge.stopQq
      }
}

export function RobotChannelWorkspace({ channel }: { channel: RobotChannel }) {
  const title = channel === 'weixin' ? '微信机器人' : 'QQ 机器人'
  const idLabel = channel === 'weixin' ? 'Bot ID' : 'App ID'
  const [state, setState] = useState<RobotViewState>({
    loading: true,
    connected: false,
    authorizationConfigured: false,
    serviceRunning: false,
    settings: DEFAULT_SETTINGS
  })
  const [profiles, setProfiles] = useState<ApiProfile[]>([])
  const [binding, setBinding] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const bridge = robotBridge()
    if (!bridge) {
      setState(current => ({ ...current, loading: false, error: '机器人桥接不可用' }))
      return
    }
    try {
      const actions = channelActions(bridge, channel)
      const [statusValue, settingsValue] = await Promise.all([actions.status(), bridge.settings()])
      setState(parseStatus(channel, statusValue))
      setProfiles(parseProfiles(settingsValue))
      setActionError(null)
    } catch (error) {
      setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [channel])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), binding ? 2000 : 5000)
    return () => window.clearInterval(timer)
  }, [binding, refresh])

  useEffect(() => {
    if (binding && state.connected) setBinding(false)
  }, [binding, state.connected])

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === state.settings.zero3ProfileId) ?? profiles[0] ?? null,
    [profiles, state.settings.zero3ProfileId]
  )

  const runAction = async (action: () => Promise<unknown>) => {
    try {
      setActionError(null)
      await action()
      await refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const bind = async () => {
    const bridge = robotBridge()
    if (!bridge) return
    const actions = channelActions(bridge, channel)
    if (state.connected && !window.confirm(`重新绑定${title}会先解除当前绑定和该通道授权码。继续吗？`)) return
    if (state.connected) await runAction(actions.disconnect)
    try {
      setActionError(null)
      await actions.bind()
      setBinding(true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveSettings = async (patch: Record<string, unknown>) => {
    const bridge = robotBridge()
    if (!bridge) return
    await runAction(() => bridge.setSettings({ channel, ...patch }))
  }

  const disconnect = async () => {
    const bridge = robotBridge()
    if (!bridge) return
    if (!window.confirm(`解除${title}绑定？本地平台凭据和该通道高风险操作授权码会一并移除。`)) return
    await runAction(channelActions(bridge, channel).disconnect)
  }

  const toggleService = async () => {
    const bridge = robotBridge()
    if (!bridge) return
    const actions = channelActions(bridge, channel)
    await runAction(state.serviceRunning ? actions.stop : actions.start)
  }

  const statusLabel = state.loading ? '检测中…' : state.error ? '不可用' : state.connected ? '已绑定' : '未绑定'
  const serviceLabel = state.serviceRunning ? '运行中' : state.connected ? '已停止' : '未启动'

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background p-6">
      <div className="mb-1 text-lg font-medium">{title}</div>
      <div className="mb-6 max-w-3xl text-sm text-(--ui-text-secondary)">
        普通消息默认交给 Zero3 API Profile；需要显式执行 Agent 时可发送 /pilot codex 或 /pilot claude，高风险执行会要求该通道授权码。
      </div>

      <div className="mb-6 max-w-3xl overflow-hidden rounded-lg border border-(--ui-border)">
        <div className="grid grid-cols-[190px_1fr] gap-y-3 px-4 py-4 text-sm">
          <div className="text-(--ui-text-secondary)">连接状态</div>
          <div className={state.connected ? 'font-medium text-green-500' : 'text-foreground'}>{statusLabel}</div>
          <div className="text-(--ui-text-secondary)">消息服务</div>
          <div className={state.serviceRunning ? 'font-medium text-green-500' : 'text-foreground'}>{serviceLabel}</div>
          <div className="text-(--ui-text-secondary)">高风险授权码</div>
          <div>{state.authorizationConfigured ? '已设置' : '未设置'}</div>
          <div className="text-(--ui-text-secondary)">{idLabel}</div>
          <div className="font-mono text-xs">{mask(state.primaryId)}</div>
          <div className="text-(--ui-text-secondary)">绑定用户</div>
          <div className="font-mono text-xs">{mask(state.ownerUserId)}</div>
          <div className="text-(--ui-text-secondary)">默认处理器</div>
          <div>{state.settings.defaultBackend === 'zero3' ? 'Zero3' : state.settings.defaultBackend === 'codex' ? 'Codex' : 'Claude'}</div>
          <div className="text-(--ui-text-secondary)">Zero3 API 模型</div>
          <div>{selectedProfile ? `${selectedProfile.name} · ${selectedProfile.model}` : '尚未配置 API Profile'}</div>
        </div>
      </div>

      <div className="mb-6 max-w-3xl rounded-lg border border-(--ui-border) px-4 py-4">
        <div className="mb-3 text-sm font-medium">消息路由</div>
        <div className="grid grid-cols-[190px_1fr] items-center gap-y-3 text-sm">
          <label htmlFor={`${channel}-backend`} className="text-(--ui-text-secondary)">默认处理器</label>
          <select
            id={`${channel}-backend`}
            value={state.settings.defaultBackend}
            onChange={event => void saveSettings({ defaultBackend: event.target.value })}
            className="max-w-sm rounded border border-(--ui-border) bg-background px-2 py-1.5"
          >
            <option value="zero3">Zero3（推荐，API Profile，只读工具）</option>
            <option value="codex">Codex（每次执行要求授权码）</option>
            <option value="claude">Claude（每次执行要求授权码）</option>
          </select>
          <label htmlFor={`${channel}-profile`} className="text-(--ui-text-secondary)">Zero3 API Profile</label>
          <select
            id={`${channel}-profile`}
            value={state.settings.zero3ProfileId ?? selectedProfile?.id ?? ''}
            onChange={event => void saveSettings({ zero3ProfileId: event.target.value || null })}
            className="max-w-sm rounded border border-(--ui-border) bg-background px-2 py-1.5"
          >
            {!profiles.length && <option value="">未配置</option>}
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
          </select>
        </div>
      </div>

      {binding && !state.connected && (
        <div className="mb-5 max-w-3xl rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm">
          绑定程序已启动。请在弹出的窗口中扫码并完成授权码设置；完成后这里会自动刷新并启动消息服务。
        </div>
      )}
      {(state.error || state.serviceError || actionError) && (
        <div className="mb-5 max-w-3xl rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          {actionError ?? state.serviceError ?? state.error}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={binding || state.loading}
          onClick={() => void bind()}
          className="rounded border border-(--ui-border) px-4 py-2 text-sm font-medium hover:bg-(--ui-control-hover-background) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.connected ? `重新绑定${channel === 'weixin' ? '微信' : ' QQ'}` : binding ? '绑定程序运行中…' : `绑定${channel === 'weixin' ? '微信' : ' QQ'}`}
        </button>
        {state.connected && (
          <button type="button" onClick={() => void toggleService()} className="rounded border border-(--ui-border) px-4 py-2 text-sm font-medium hover:bg-(--ui-control-hover-background)">
            {state.serviceRunning ? '停止消息服务' : '启动消息服务'}
          </button>
        )}

        <button type="button" onClick={() => void refresh()} className="rounded border border-(--ui-border) px-4 py-2 text-sm font-medium hover:bg-(--ui-control-hover-background)">
          刷新状态
        </button>
        {state.connected && (
          <button type="button" onClick={() => void disconnect()} className="rounded border border-red-500/30 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-500/5">
            解除绑定
          </button>
        )}
      </div>

      <div className="mt-6 max-w-3xl text-xs leading-5 text-(--ui-text-tertiary)">
        普通消息无需 /pilot。Zero3 默认在只读沙箱中回答；需要修改文件、执行项目任务等操作时，请显式使用 /pilot codex 或 /pilot claude，并按提示发送授权码。
      </div>
    </div>
  )
}
