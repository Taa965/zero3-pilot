import { useEffect, useState } from 'react'

import { WeixinRobotWorkspace } from './WeixinRobotWorkspace'
import { QqRobotWorkspace } from './QqRobotWorkspace'
import type { RuntimeTarget } from './runtime-types'

type ShellState = {
  kind: string
  status: 'ready' | 'unavailable'
  version?: string
  preferred: boolean
}

type RuntimeCapabilityState = {
  loading: boolean
  error?: string
  platform?: string
  arch?: string
  policy?: string
  preferred?: string
  shells: ShellState[]
}

type RuntimeBridge = {
  runtimeCapabilities?: () => Promise<unknown>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseRuntimeCapabilities(value: unknown): RuntimeCapabilityState {
  const root = record(value)
  const executors = Array.isArray(root.executors) ? root.executors.map(record) : []
  const native = executors.find(executor => executor.executorId === 'native-codex') ?? {}
  const capabilities = record(native.capabilities)
  const shell = record(capabilities.shell)
  const preferred = typeof shell.preferred === 'string' ? shell.preferred : undefined
  const shells = Array.isArray(shell.shells)
    ? shell.shells.map(record).flatMap(candidate => {
        const kind = typeof candidate.kind === 'string' ? candidate.kind : ''
        const status = candidate.status === 'ready' || candidate.status === 'unavailable' ? candidate.status : null
        if (!kind || !status) return []
        return [{
          kind,
          status,
          version: typeof candidate.version === 'string' ? candidate.version : undefined,
          preferred: kind === preferred
        } satisfies ShellState]
      })
    : []

  return {
    loading: false,
    platform: typeof root.platform === 'string' ? root.platform : undefined,
    arch: typeof root.arch === 'string' ? root.arch : undefined,
    policy: typeof shell.policy === 'string' ? shell.policy : undefined,
    preferred,
    shells
  }
}

function shellLabel(kind: string): string {
  if (kind === 'pwsh') return 'PowerShell 7+ (pwsh)'
  if (kind === 'powershell') return 'Windows PowerShell'
  if (kind === 'cmd') return 'Command Prompt (cmd)'
  if (kind === 'wsl') return 'Windows Subsystem for Linux'
  return kind
}

function KernelRuntimeWorkspace() {
  const [runtime, setRuntime] = useState<RuntimeCapabilityState>({ loading: true, shells: [] })

  useEffect(() => {
    let cancelled = false
    const bridge = (window as typeof window & { zero3DevelopmentGroup?: RuntimeBridge }).zero3DevelopmentGroup
    if (!bridge?.runtimeCapabilities) {
      setRuntime({ loading: false, shells: [], error: '运行时能力桥接不可用' })
      return () => { cancelled = true }
    }
    void bridge.runtimeCapabilities()
      .then(value => { if (!cancelled) setRuntime(parseRuntimeCapabilities(value)) })
      .catch(error => {
        if (!cancelled) setRuntime({ loading: false, shells: [], error: error instanceof Error ? error.message : String(error) })
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex h-full flex-col bg-background p-6 overflow-y-auto">
      <div className="font-medium text-lg mb-6">Codex 核心 (Kernel)</div>

      <div className="grid grid-cols-2 gap-y-4 gap-x-8 max-w-2xl mb-8 text-sm">
        <div className="text-(--ui-text-secondary)">运行状态</div>
        <div className="text-green-500 font-medium">就绪 (READY)</div>

        <div className="text-(--ui-text-secondary)">应用服务</div>
        <div className="text-foreground">运行中 (RUNNING)</div>

        <div className="text-(--ui-text-secondary)">二进制程序</div>
        <div className="text-foreground font-mono text-xs">内置 (bundled)</div>

        <div className="text-(--ui-text-secondary)">平台</div>
        <div className="text-foreground font-mono text-xs">
          {runtime.loading ? '检测中…' : [runtime.platform, runtime.arch].filter(Boolean).join(' / ') || '未知'}
        </div>

        <div className="text-(--ui-text-secondary)">会话来源</div>
        <div className="text-foreground">app-server</div>
      </div>

      <div className="max-w-2xl rounded-lg border border-(--ui-border) mb-8">
        <div className="border-b border-(--ui-border) px-4 py-3">
          <div className="font-medium text-sm">Shell Capability</div>
          <div className="text-xs text-(--ui-text-secondary) mt-1">
            {runtime.error
              ? `探测失败：${runtime.error}`
              : runtime.loading
                ? '正在探测 pwsh / Windows PowerShell / cmd / WSL…'
                : `执行策略：${runtime.policy === 'codex-native' ? 'Codex 原生审批与沙箱策略' : runtime.policy ?? '未知'}`}
          </div>
        </div>
        <div className="divide-y divide-(--ui-border)">
          {!runtime.loading && !runtime.error && runtime.shells.length === 0 && (
            <div className="px-4 py-3 text-sm text-(--ui-text-secondary)">未发现可用 Shell。</div>
          )}
          {runtime.shells.map(shell => (
            <div key={shell.kind} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {shellLabel(shell.kind)}{shell.preferred ? ' · 首选' : ''}
                </div>
                {shell.version && <div className="mt-0.5 truncate font-mono text-xs text-(--ui-text-secondary)">{shell.version}</div>}
              </div>
              <div className={shell.status === 'ready' ? 'text-green-500 font-medium text-xs' : 'text-(--ui-text-tertiary) text-xs'}>
                {shell.status === 'ready' ? 'READY' : 'UNAVAILABLE'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-4">
        <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">重启 Kernel</button>
        <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">查看日志</button>
      </div>
    </div>
  )
}

export function RuntimeWorkspace({ target }: { target: RuntimeTarget }) {
  if (target === 'weixin') return <WeixinRobotWorkspace />
  if (target === 'qq') return <QqRobotWorkspace />
  return <KernelRuntimeWorkspace />
}
