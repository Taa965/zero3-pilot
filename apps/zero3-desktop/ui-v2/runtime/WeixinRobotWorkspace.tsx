import { useCallback, useEffect, useMemo, useState } from 'react'

interface WeixinRobotBridge {
  weixinStatus: () => Promise<unknown>
  launchWeixinBinding: () => Promise<unknown>
  disconnectWeixin: () => Promise<unknown>
}

type WeixinRobotState = {
  loading: boolean
  connected: boolean
  authorizationConfigured: boolean
  botId?: string
  ownerUserId?: string
  error?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseStatus(value: unknown): WeixinRobotState {
  const root = record(value)
  const weixin = record(root.weixin)
  return {
    loading: false,
    connected: weixin.connected === true,
    authorizationConfigured: root.authorization_configured === true,
    botId: typeof weixin.bot_id === 'string' ? weixin.bot_id : undefined,
    ownerUserId: typeof weixin.owner_user_id === 'string' ? weixin.owner_user_id : undefined
  }
}

function robotBridge(): WeixinRobotBridge | null {
  const bridge = (window as typeof window & { zero3Robots?: WeixinRobotBridge }).zero3Robots
  return bridge ?? null
}

function mask(value?: string): string {
  if (!value) return '—'
  if (value.length <= 10) return value
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function WeixinRobotWorkspace() {
  const [status, setStatus] = useState<WeixinRobotState>({
    loading: true,
    connected: false,
    authorizationConfigured: false
  })
  const [binding, setBinding] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const bridge = robotBridge()
    if (!bridge) {
      setStatus({ loading: false, connected: false, authorizationConfigured: false, error: '机器人桥接不可用' })
      return
    }
    try {
      setStatus(current => ({ ...current, loading: true, error: undefined }))
      setStatus(parseStatus(await bridge.weixinStatus()))
      setActionError(null)
    } catch (error) {
      setStatus(current => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!binding || status.connected) {
      if (status.connected) setBinding(false)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > 2 * 60 * 1000) {
        window.clearInterval(timer)
        setBinding(false)
        return
      }
      void refresh()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [binding, refresh, status.connected])

  const statusLabel = useMemo(() => {
    if (status.loading) return '检测中…'
    if (status.error) return '不可用'
    return status.connected ? '已绑定' : '未绑定'
  }, [status])

  const launchBinding = async (rebind = false) => {
    const bridge = robotBridge()
    if (!bridge) return
    try {
      setActionError(null)
      if (rebind) {
        const approved = window.confirm('重新绑定会先解除当前微信绑定和高风险操作授权码。继续吗？')
        if (!approved) return
        await bridge.disconnectWeixin()
      }
      await bridge.launchWeixinBinding()
      setBinding(true)
      void refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const disconnect = async () => {
    const bridge = robotBridge()
    if (!bridge) return
    if (!window.confirm('解除微信机器人绑定？本地微信凭据和高风险操作授权码会一并移除。')) return
    try {
      setActionError(null)
      await bridge.disconnectWeixin()
      setBinding(false)
      await refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background p-6">
      <div className="mb-1 text-lg font-medium">微信机器人</div>
      <div className="mb-6 max-w-2xl text-sm text-(--ui-text-secondary)">
        微信作为 Zero3 的消息入口。首次绑定会启动独立绑定程序，扫码成功后设置高风险操作授权码。
      </div>

      <div className="mb-6 max-w-2xl overflow-hidden rounded-lg border border-(--ui-border)">
        <div className="grid grid-cols-[180px_1fr] gap-y-3 px-4 py-4 text-sm">
          <div className="text-(--ui-text-secondary)">连接状态</div>
          <div className={status.connected ? 'font-medium text-green-500' : 'text-foreground'}>{statusLabel}</div>
          <div className="text-(--ui-text-secondary)">高风险授权码</div>
          <div className="text-foreground">{status.authorizationConfigured ? '已设置' : '未设置'}</div>
          <div className="text-(--ui-text-secondary)">Bot ID</div>
          <div className="font-mono text-xs text-foreground">{mask(status.botId)}</div>
          <div className="text-(--ui-text-secondary)">绑定用户</div>
          <div className="font-mono text-xs text-foreground">{mask(status.ownerUserId)}</div>
        </div>
      </div>

      {binding && !status.connected && (
        <div className="mb-5 max-w-2xl rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm">
          绑定程序已启动。请在弹出的窗口中按提示使用微信扫码，并完成授权码设置；这里会自动刷新状态。
        </div>
      )}

      {(status.error || actionError) && (
        <div className="mb-5 max-w-2xl rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          {actionError ?? status.error}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={binding || status.loading || Boolean(status.error)}
          onClick={() => void launchBinding(status.connected)}
          className="rounded border border-(--ui-border) px-4 py-2 text-sm font-medium hover:bg-(--ui-control-hover-background) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.connected ? '重新绑定微信' : binding ? '绑定程序运行中…' : '绑定微信'}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-(--ui-border) px-4 py-2 text-sm font-medium hover:bg-(--ui-control-hover-background)"
        >
          刷新状态
        </button>
        {status.connected && (
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded border border-red-500/30 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-500/5"
          >
            解除绑定
          </button>
        )}
      </div>
    </div>
  )
}
