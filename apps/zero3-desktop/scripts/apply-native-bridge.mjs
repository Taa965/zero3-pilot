import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 native bridge drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

function writeGeneratedFile(relativePath, marker, content) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })

  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8')
    if (current === content) return
    if (!current.includes(marker)) {
      throw new Error(`Refusing to overwrite non-Zero3 generated file: ${relativePath}`)
    }
  }

  fs.writeFileSync(file, content)
}

const ZERO3_CONTROL_SETTINGS = `// ZERO3_GENERATED_NATIVE_CONTROL
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { RefreshCw, Settings2 } from '@/lib/icons'

import { ListRow, Pill, SectionHeading, SettingsContent } from './primitives'

type JsonRecord = Record<string, unknown>

type Snapshot = {
  health: JsonRecord
  status: JsonRecord
  jobs: unknown[]
  schedules: unknown[]
  memory: unknown[]
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function agentName(value: unknown, index: number) {
  if (typeof value === 'string') return value
  const item = record(value)
  return text(item.name, text(item.id, text(item.backend, 'Agent ' + String(index + 1))))
}

export function Zero3ControlSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [agentBackend, setAgentBackend] = useState('')
  const [agentGoal, setAgentGoal] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const bridge = window.zero3Desktop
      if (!bridge) throw new Error('Zero3 Desktop Bridge 不可用')
      const [health, status, jobs, schedules, memory] = await Promise.all([
        bridge.health(),
        bridge.status(),
        bridge.jobs(),
        bridge.schedules(),
        bridge.memory()
      ])
      setSnapshot({ health, status, jobs, schedules, memory })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const agents = useMemo(() => {
    const value = snapshot?.status.agents
    return Array.isArray(value) ? value : []
  }, [snapshot])

  useEffect(() => {
    if (!agentBackend && agents.length > 0) {
      setAgentBackend(agentName(agents[0], 0))
    }
  }, [agentBackend, agents])

  const dispatchAgent = useCallback(async () => {
    const goal = agentGoal.trim()
    if (!agentBackend || !goal) {
      setDispatchMessage('请选择 Agent 并填写任务目标')
      return
    }

    setDispatching(true)
    setDispatchMessage(null)

    try {
      const accepted = await window.zero3Desktop.dispatchAgent({
        backend: agentBackend,
        goal,
        context: { source: 'zero3-control' }
      })
      setAgentGoal('')
      setDispatchMessage('已提交 Agent 任务：' + accepted.job_id)
      await refresh()
    } catch (nextError) {
      setDispatchMessage('Agent 执行失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setDispatching(false)
    }
  }, [agentBackend, agentGoal, refresh])

  const browser = record(snapshot?.status.browser)
  const computer = record(snapshot?.status.computer)
  const online = snapshot?.health.status === 'ok'

  return (
    <SettingsContent>
      <div className="flex items-start justify-between gap-3 pt-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Zero3 总控</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            通过 Electron 主进程的白名单 IPC 连接本机 Zero3 Node。渲染器不能访问任意 localhost 路径。
          </p>
        </div>
        <Button disabled={loading} onClick={() => void refresh()} size="sm" type="button" variant="outline">
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          刷新
        </Button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Zero3 Node', online ? '在线' : '离线'],
          ['任务', String(snapshot?.jobs.length ?? 0)],
          ['定时任务', String(snapshot?.schedules.length ?? 0)],
          ['记忆', String(snapshot?.memory.length ?? 0)]
        ].map(([label, value]) => (
          <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3" key={label}>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-base font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          无法读取 Zero3 Node：{error}
        </div>
      )}

      <div className="mt-7">
        <SectionHeading icon={Settings2} meta={online ? '就绪' : '离线'} title="运行状态" />
        <ListRow
          action={<Pill tone={online ? 'primary' : 'warn'}>{online ? '在线' : '离线'}</Pill>}
          description={'版本 ' + text(snapshot?.health.version, text(snapshot?.status.version))}
          title="Zero3 Pilot Node"
        />
        <ListRow
          description={agents.length ? agents.map(agentName).join(' · ') : '未发现已注册 Agent'}
          title={'Agent · ' + String(agents.length)}
        />
        <ListRow description={text(browser.name, '未就绪')} title="Browser" />
        <ListRow description={text(computer.name, '未就绪')} title="Computer Use" />
      </div>

      <div className="mt-7">
        <SectionHeading icon={Settings2} title="Agent 执行" />
        <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
          <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              Agent
              <select
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
                disabled={!online || dispatching || agents.length === 0}
                onChange={event => setAgentBackend(event.target.value)}
                value={agentBackend}
              >
                {agents.map((agent, index) => {
                  const name = agentName(agent, index)
                  return (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  )
                })}
              </select>
            </label>

            <label className="grid gap-1.5 text-xs text-muted-foreground">
              任务目标
              <textarea
                className="min-h-24 resize-y rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-2 text-sm leading-5 text-foreground outline-none"
                disabled={!online || dispatching}
                maxLength={20000}
                onChange={event => setAgentGoal(event.target.value)}
                placeholder="例如：检查当前项目最近一次 CI 失败原因，并给出修复方案。"
                value={agentGoal}
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              Agent dispatch 需要提升权限时，由 Electron 主进程弹出原生确认；渲染器不能自行设置 approved 或权限等级。
            </p>
            <Button
              disabled={!online || dispatching || !agentBackend || !agentGoal.trim()}
              onClick={() => void dispatchAgent()}
              size="sm"
              type="button"
            >
              {dispatching ? '提交中…' : '执行 Agent'}
            </Button>
          </div>

          {dispatchMessage && (
            <div className="mt-3 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2 text-xs leading-5">
              {dispatchMessage}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B2 已开放第一个受控写入面：Agent dispatch。健康状态、系统状态、任务、定时任务和记忆仍通过固定只读资源读取；Schedule、Memory、Browser 和 Computer 写操作继续保持关闭，后续按独立白名单与原生审批逐项开放。
      </div>
    </SettingsContent>
  )
}
`

export const ZERO3_GENERATED_NATIVE_FILES = ['src/app/settings/zero3-control-settings.tsx']

export function applyZero3NativeBridge() {
  patchFile('electron/main.ts', [
    {
      label: 'Zero3 Node allowlisted read IPC',
      from: "ipcMain.handle('hermes:api', async (_event, request) => {",
      to: `const ZERO3_NODE_PORT = Number(process.env.ZERO3_PILOT_NODE_PORT ?? '8790')
const ZERO3_NODE_BASE = \`http://127.0.0.1:\${Number.isFinite(ZERO3_NODE_PORT) ? ZERO3_NODE_PORT : 8790}\`
const ZERO3_READ_ROUTES = {
  health: '/health',
  status: '/api/v1/status',
  jobs: '/api/v1/jobs',
  schedules: '/api/v1/schedules',
  memory: '/api/v1/memory'
} as const

type Zero3ReadResource = keyof typeof ZERO3_READ_ROUTES

async function readZero3Node(resource: Zero3ReadResource): Promise<unknown> {
  const route = ZERO3_READ_ROUTES[resource]
  const response = await fetch(ZERO3_NODE_BASE + route, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(2500)
  })

  if (!response.ok) {
    throw new Error(\`Zero3 Node \${resource} request failed with HTTP \${response.status}\`)
  }

  return response.json()
}

ipcMain.handle('zero3:read', async (_event, resource: unknown) => {
  if (typeof resource !== 'string' || !Object.hasOwn(ZERO3_READ_ROUTES, resource)) {
    throw new Error('Zero3 Desktop Bridge rejected a non-allowlisted resource')
  }

  return readZero3Node(resource as Zero3ReadResource)
})

type Zero3AgentDispatchPayload = {
  backend: string
  goal: string
  context: Record<string, unknown>
}

function parseZero3AgentDispatch(value: unknown): Zero3AgentDispatchPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 Agent dispatch payload must be an object')
  }

  const payload = value as Record<string, unknown>
  const backend = typeof payload.backend === 'string' ? payload.backend.trim() : ''
  const goal = typeof payload.goal === 'string' ? payload.goal.trim() : ''
  const contextValue = payload.context

  if (!backend || backend.length > 128) {
    throw new Error('Zero3 Agent backend is required and must be at most 128 characters')
  }
  if (!goal || goal.length > 20000) {
    throw new Error('Zero3 Agent goal is required and must be at most 20000 characters')
  }
  if (contextValue !== undefined && (!contextValue || typeof contextValue !== 'object' || Array.isArray(contextValue))) {
    throw new Error('Zero3 Agent context must be an object')
  }

  return {
    backend,
    goal,
    context: (contextValue as Record<string, unknown> | undefined) ?? {}
  }
}

async function postZero3Agent(
  payload: Zero3AgentDispatchPayload,
  approved: boolean
): Promise<Response> {
  return fetch(ZERO3_NODE_BASE + '/api/v1/jobs/agent', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      backend: payload.backend,
      goal: payload.goal,
      context: payload.context,
      granted_level: 'Standard',
      approved
    }),
    signal: AbortSignal.timeout(10000)
  })
}

async function zero3NodeError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
  } catch {
    // Fall through to the status-only error below.
  }
  return \`Zero3 Node request failed with HTTP \${response.status}\`
}

async function dispatchZero3Agent(value: unknown): Promise<unknown> {
  const payload = parseZero3AgentDispatch(value)
  let response = await postZero3Agent(payload, false)

  if (response.status === 428) {
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Zero3 权限确认',
      message: 'Agent 执行需要一次提升权限',
      detail: \`Agent：\${payload.backend}\\n任务：\${payload.goal.slice(0, 1200)}\`,
      buttons: ['取消', '批准一次'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    })

    if (confirmation.response !== 1) {
      throw new Error('已取消 Agent 执行')
    }

    response = await postZero3Agent(payload, true)
  }

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  return response.json()
}

ipcMain.handle('zero3:agent:dispatch', async (_event, request: unknown) => {
  return dispatchZero3Agent(request)
})

ipcMain.handle('hermes:api', async (_event, request) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'Zero3 preload bridge',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: `contextBridge.exposeInMainWorld('zero3Desktop', {
  health: () => ipcRenderer.invoke('zero3:read', 'health'),
  status: () => ipcRenderer.invoke('zero3:read', 'status'),
  jobs: () => ipcRenderer.invoke('zero3:read', 'jobs'),
  schedules: () => ipcRenderer.invoke('zero3:read', 'schedules'),
  memory: () => ipcRenderer.invoke('zero3:read', 'memory'),
  dispatchAgent: request => ipcRenderer.invoke('zero3:agent:dispatch', request)
})

contextBridge.exposeInMainWorld('hermesDesktop', {`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 renderer bridge types',
      from: `  interface Window {
    hermesDesktop: {`,
      to: `  interface Window {
    zero3Desktop: {
      health: () => Promise<Record<string, unknown>>
      status: () => Promise<Record<string, unknown>>
      jobs: () => Promise<unknown[]>
      schedules: () => Promise<unknown[]>
      memory: () => Promise<unknown[]>
      dispatchAgent: (request: {
        backend: string
        goal: string
        context?: Record<string, unknown>
      }) => Promise<{ job_id: string }>
    }
    hermesDesktop: {`
    }
  ])

  patchFile('src/app/settings/types.ts', [
    {
      label: 'Zero3 settings route type',
      from: `export type SettingsView =
  | 'about'`,
      to: `export type SettingsView =
  | 'zero3'
  | 'about'`
    }
  ])

  patchFile('src/app/settings/index.tsx', [
    {
      label: 'Zero3 control page import',
      from: "import { AboutSettings } from './about-settings'\n",
      to: "import { AboutSettings } from './about-settings'\nimport { Zero3ControlSettings } from './zero3-control-settings'\n"
    },
    {
      label: 'Zero3 settings route entry',
      from: "  ...SECTIONS.map(s => `config:${s.id}` as SettingsViewId),\n  'providers',",
      to: "  ...SECTIONS.map(s => `config:${s.id}` as SettingsViewId),\n  'zero3',\n  'providers',"
    },
    {
      label: 'locale-aware Zero3 navigation',
      from: '  const { t } = useI18n()',
      to: '  const { locale, t } = useI18n()'
    },
    {
      label: 'Zero3 control navigation item',
      from: `      {
        active: activeView === 'about',
        gapBefore: true,
        icon: Info,
        id: 'about',`,
      to: `      {
        active: activeView === 'zero3',
        gapBefore: true,
        icon: Settings2,
        id: 'zero3',
        label: locale === 'zh' ? 'Zero3 总控' : locale === 'zh-hant' ? 'Zero3 總控' : 'Zero3 Control',
        onSelect: () => setActiveView('zero3')
      },
      {
        active: activeView === 'about',
        icon: Info,
        id: 'about',`
    },
    {
      label: 'Zero3 control navigation memo dependency',
      from: '[activeView, keysView, providerView, t, setActiveView, openProviderView, openKeysView]',
      to: '[activeView, keysView, locale, providerView, t, setActiveView, openProviderView, openKeysView]'
    },
    {
      label: 'Zero3 control settings renderer',
      from: `    activeView === 'config:appearance' ? (
      <AppearanceSettings />
    ) : activeView === 'about' ? (`,
      to: `    activeView === 'config:appearance' ? (
      <AppearanceSettings />
    ) : activeView === 'zero3' ? (
      <Zero3ControlSettings />
    ) : activeView === 'about' ? (`
    }
  ])

  writeGeneratedFile(
    'src/app/settings/zero3-control-settings.tsx',
    'ZERO3_GENERATED_NATIVE_CONTROL',
    ZERO3_CONTROL_SETTINGS
  )
}
