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

const ZERO3_CONTROL_SETTINGS = `// ZERO3_GENERATED_NATIVE_CONTROL\nimport { useCallback, useEffect, useMemo, useState } from 'react'\n\nimport { Button } from '@/components/ui/button'\nimport { RefreshCw, Settings2 } from '@/lib/icons'\n\nimport { ListRow, Pill, SectionHeading, SettingsContent } from './primitives'\n\ntype JsonRecord = Record<string, unknown>\n\ntype Snapshot = {\n  health: JsonRecord\n  status: JsonRecord\n  jobs: unknown[]\n  schedules: unknown[]\n  memory: unknown[]\n}\n\nfunction record(value: unknown): JsonRecord {\n  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}\n}\n\nfunction text(value: unknown, fallback = '—') {\n  return typeof value === 'string' && value.trim() ? value : fallback\n}\n\nfunction agentName(value: unknown, index: number) {\n  if (typeof value === 'string') return value\n  const item = record(value)\n  return text(item.name, text(item.id, text(item.backend, 'Agent ' + String(index + 1))))\n}\n\nexport function Zero3ControlSettings() {\n  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)\n  const [error, setError] = useState<string | null>(null)\n  const [loading, setLoading] = useState(false)\n\n  const refresh = useCallback(async () => {\n    setLoading(true)\n    setError(null)\n\n    try {\n      const bridge = window.zero3Desktop\n      if (!bridge) throw new Error('Zero3 Desktop Bridge 不可用')\n      const [health, status, jobs, schedules, memory] = await Promise.all([\n        bridge.health(),\n        bridge.status(),\n        bridge.jobs(),\n        bridge.schedules(),\n        bridge.memory()\n      ])\n      setSnapshot({ health, status, jobs, schedules, memory })\n    } catch (nextError) {\n      setError(nextError instanceof Error ? nextError.message : String(nextError))\n    } finally {\n      setLoading(false)\n    }\n  }, [])\n\n  useEffect(() => {\n    void refresh()\n  }, [refresh])\n\n  const agents = useMemo(() => {\n    const value = snapshot?.status.agents\n    return Array.isArray(value) ? value : []\n  }, [snapshot])\n\n  const browser = record(snapshot?.status.browser)\n  const computer = record(snapshot?.status.computer)\n  const online = snapshot?.health.status === 'ok'\n\n  return (\n    <SettingsContent>\n      <div className=\"flex items-start justify-between gap-3 pt-6\">\n        <div>\n          <h2 className=\"text-lg font-semibold tracking-tight\">Zero3 总控</h2>\n          <p className=\"mt-1 max-w-2xl text-xs leading-5 text-muted-foreground\">\n            通过 Electron 主进程的白名单 IPC 读取本机 Zero3 Node。渲染器不能访问任意 localhost 路径。\n          </p>\n        </div>\n        <Button disabled={loading} onClick={() => void refresh()} size=\"sm\" type=\"button\" variant=\"outline\">\n          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />\n          刷新\n        </Button>\n      </div>\n\n      <div className=\"mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4\">\n        {[\n          ['Zero3 Node', online ? '在线' : '离线'],\n          ['任务', String(snapshot?.jobs.length ?? 0)],\n          ['定时任务', String(snapshot?.schedules.length ?? 0)],\n          ['记忆', String(snapshot?.memory.length ?? 0)]\n        ].map(([label, value]) => (\n          <div className=\"rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3\" key={label}>\n            <div className=\"text-xs text-muted-foreground\">{label}</div>\n            <div className=\"mt-1 text-base font-semibold\">{value}</div>\n          </div>\n        ))}\n      </div>\n\n      {error && (\n        <div className=\"mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive\">\n          无法读取 Zero3 Node：{error}\n        </div>\n      )}\n\n      <div className=\"mt-7\">\n        <SectionHeading icon={Settings2} meta={online ? '就绪' : '离线'} title=\"运行状态\" />\n        <ListRow\n          action={<Pill tone={online ? 'primary' : 'warn'}>{online ? '在线' : '离线'}</Pill>}\n          description={'版本 ' + text(snapshot?.health.version, text(snapshot?.status.version))}\n          title=\"Zero3 Pilot Node\"\n        />\n        <ListRow\n          description={agents.length ? agents.map(agentName).join(' · ') : '未发现已注册 Agent'}\n          title={'Agent · ' + String(agents.length)}\n        />\n        <ListRow description={text(browser.name, '未就绪')} title=\"Browser\" />\n        <ListRow description={text(computer.name, '未就绪')} title=\"Computer Use\" />\n      </div>\n\n      <div className=\"mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground\">\n        当前 Phase B 仅开放只读资源：健康状态、系统状态、任务、定时任务和记忆。创建任务、修改定时任务、写入记忆及 Browser/Computer 写操作仍由 Zero3 Node 权限策略控制，后续按独立白名单逐项开放。\n      </div>\n    </SettingsContent>\n  )\n}\n`

export const ZERO3_GENERATED_NATIVE_FILES = ['src/app/settings/zero3-control-settings.tsx']

export function applyZero3NativeBridge() {
  patchFile('electron/main.ts', [
    {
      label: 'Zero3 Node allowlisted read IPC',
      from: "ipcMain.handle('hermes:api', async (_event, request) => {",
      to: `const ZERO3_NODE_PORT = Number(process.env.ZERO3_PILOT_NODE_PORT ?? '8790')\nconst ZERO3_NODE_BASE = \`http://127.0.0.1:\${Number.isFinite(ZERO3_NODE_PORT) ? ZERO3_NODE_PORT : 8790}\`\nconst ZERO3_READ_ROUTES = {\n  health: '/health',\n  status: '/api/v1/status',\n  jobs: '/api/v1/jobs',\n  schedules: '/api/v1/schedules',\n  memory: '/api/v1/memory'\n} as const\n\ntype Zero3ReadResource = keyof typeof ZERO3_READ_ROUTES\n\nasync function readZero3Node(resource: Zero3ReadResource): Promise<unknown> {\n  const route = ZERO3_READ_ROUTES[resource]\n  const response = await fetch(ZERO3_NODE_BASE + route, {\n    headers: { accept: 'application/json' },\n    signal: AbortSignal.timeout(2500)\n  })\n\n  if (!response.ok) {\n    throw new Error(\`Zero3 Node \${resource} request failed with HTTP \${response.status}\`)\n  }\n\n  return response.json()\n}\n\nipcMain.handle('zero3:read', async (_event, resource: unknown) => {\n  if (typeof resource !== 'string' || !Object.hasOwn(ZERO3_READ_ROUTES, resource)) {\n    throw new Error('Zero3 Desktop Bridge rejected a non-allowlisted resource')\n  }\n\n  return readZero3Node(resource as Zero3ReadResource)\n})\n\nipcMain.handle('hermes:api', async (_event, request) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'Zero3 preload bridge',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: `contextBridge.exposeInMainWorld('zero3Desktop', {\n  health: () => ipcRenderer.invoke('zero3:read', 'health'),\n  status: () => ipcRenderer.invoke('zero3:read', 'status'),\n  jobs: () => ipcRenderer.invoke('zero3:read', 'jobs'),\n  schedules: () => ipcRenderer.invoke('zero3:read', 'schedules'),\n  memory: () => ipcRenderer.invoke('zero3:read', 'memory')\n})\n\ncontextBridge.exposeInMainWorld('hermesDesktop', {`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 renderer bridge types',
      from: `  interface Window {\n    hermesDesktop: {`,
      to: `  interface Window {\n    zero3Desktop: {\n      health: () => Promise<Record<string, unknown>>\n      status: () => Promise<Record<string, unknown>>\n      jobs: () => Promise<unknown[]>\n      schedules: () => Promise<unknown[]>\n      memory: () => Promise<unknown[]>\n    }\n    hermesDesktop: {`
    }
  ])

  patchFile('src/app/settings/types.ts', [
    {
      label: 'Zero3 settings route type',
      from: `export type SettingsView =\n  | 'about'`,
      to: `export type SettingsView =\n  | 'zero3'\n  | 'about'`
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
      from: `      {\n        active: activeView === 'about',\n        gapBefore: true,\n        icon: Info,\n        id: 'about',`,
      to: `      {\n        active: activeView === 'zero3',\n        gapBefore: true,\n        icon: Settings2,\n        id: 'zero3',\n        label: locale === 'zh' ? 'Zero3 总控' : locale === 'zh-hant' ? 'Zero3 總控' : 'Zero3 Control',\n        onSelect: () => setActiveView('zero3')\n      },\n      {\n        active: activeView === 'about',\n        icon: Info,\n        id: 'about',`
    },
    {
      label: 'Zero3 control navigation memo dependency',
      from: '[activeView, keysView, providerView, t, setActiveView, openProviderView, openKeysView]',
      to: '[activeView, keysView, locale, providerView, t, setActiveView, openProviderView, openKeysView]'
    },
    {
      label: 'Zero3 control settings renderer',
      from: `    activeView === 'config:appearance' ? (\n      <AppearanceSettings />\n    ) : activeView === 'about' ? (`,
      to: `    activeView === 'config:appearance' ? (\n      <AppearanceSettings />\n    ) : activeView === 'zero3' ? (\n      <Zero3ControlSettings />\n    ) : activeView === 'about' ? (`
    }
  ])

  writeGeneratedFile(
    'src/app/settings/zero3-control-settings.tsx',
    'ZERO3_GENERATED_NATIVE_CONTROL',
    ZERO3_CONTROL_SETTINGS
  )
}
