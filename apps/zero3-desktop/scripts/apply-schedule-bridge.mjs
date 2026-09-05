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
        `Zero3 schedule bridge drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source or preceding Zero3 overlays changed; review the schedule overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3ScheduleBridge() {
  patchFile('electron/main.ts', [
    {
      label: 'native-approved Zero3 schedule IPC after memory IPC',
      from: `ipcMain.handle('zero3:memory:put', async (_event, request: unknown) => {
  return putZero3Memory(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`,
      to: `ipcMain.handle('zero3:memory:put', async (_event, request: unknown) => {
  return putZero3Memory(request)
})

type Zero3ScheduleSpecInput =
  | { kind: 'once' }
  | { kind: 'every_seconds'; seconds: number }
  | { kind: 'daily_utc'; hour: number; minute: number }

type Zero3ScheduleAgentPayload = {
  backend: 'codex' | 'claude' | 'hermes'
  goal: string
  schedule: Zero3ScheduleSpecInput
  firstRunAt: string
}

const ZERO3_SCHEDULE_AGENT_BACKENDS = new Set(['codex', 'claude', 'hermes'])

function parseZero3ScheduleSpec(value: unknown): Zero3ScheduleSpecInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 schedule spec must be an object')
  }

  const spec = value as Record<string, unknown>
  if (spec.kind === 'once') return { kind: 'once' }

  if (spec.kind === 'every_seconds') {
    const seconds = spec.seconds
    if (!Number.isSafeInteger(seconds) || typeof seconds !== 'number' || seconds < 60 || seconds > 2_678_400) {
      throw new Error('Zero3 repeating schedules must run every 60 seconds to 31 days')
    }
    return { kind: 'every_seconds', seconds }
  }

  if (spec.kind === 'daily_utc') {
    const hour = spec.hour
    const minute = spec.minute
    if (
      typeof hour !== 'number' ||
      typeof minute !== 'number' ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error('Zero3 daily UTC schedules require hour 0-23 and minute 0-59')
    }
    return { kind: 'daily_utc', hour, minute }
  }

  throw new Error('Zero3 schedule kind is not allowlisted')
}

function parseZero3ScheduleAgent(value: unknown): Zero3ScheduleAgentPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 schedule payload must be an object')
  }

  const payload = value as Record<string, unknown>
  const backend = typeof payload.backend === 'string' ? payload.backend.trim() : ''
  const goal = typeof payload.goal === 'string' ? payload.goal.trim() : ''
  const firstRunAt = typeof payload.firstRunAt === 'string' ? payload.firstRunAt.trim() : ''

  if (!ZERO3_SCHEDULE_AGENT_BACKENDS.has(backend)) {
    throw new Error('Zero3 scheduled Agent backend is not allowlisted')
  }
  if (!goal || goal.length > 20_000) {
    throw new Error('Zero3 scheduled Agent goal is required and must be at most 20000 characters')
  }

  const firstRunTimestamp = Date.parse(firstRunAt)
  if (!Number.isFinite(firstRunTimestamp)) {
    throw new Error('Zero3 schedule first run must be a valid date-time')
  }
  if (firstRunTimestamp < Date.now() - 30_000) {
    throw new Error('Zero3 schedule first run must not be in the past')
  }

  return {
    backend: backend as Zero3ScheduleAgentPayload['backend'],
    goal,
    schedule: parseZero3ScheduleSpec(payload.schedule),
    firstRunAt: new Date(firstRunTimestamp).toISOString()
  }
}

function zero3ScheduleDescription(spec: Zero3ScheduleSpecInput) {
  if (spec.kind === 'once') return '单次执行'
  if (spec.kind === 'every_seconds') return '每 ' + String(spec.seconds) + ' 秒执行'
  return '每日 UTC ' + String(spec.hour).padStart(2, '0') + ':' + String(spec.minute).padStart(2, '0')
}

async function postZero3AgentSchedule(payload: Zero3ScheduleAgentPayload, approved: boolean) {
  return fetch(ZERO3_NODE_BASE + '/api/v1/schedules', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      job_kind: 'subagent',
      payload: {
        backend: payload.backend,
        goal: payload.goal,
        context: { source: 'zero3-desktop-schedule' },
        granted_level: 'Standard',
        approved
      },
      schedule: payload.schedule,
      first_run_at: payload.firstRunAt,
      granted_level: 'Standard',
      approved
    }),
    signal: AbortSignal.timeout(10_000)
  })
}

async function createZero3AgentSchedule(value: unknown): Promise<{ schedule_id: string }> {
  const payload = parseZero3ScheduleAgent(value)
  let response = await postZero3AgentSchedule(payload, false)

  if (response.status === 428) {
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Zero3 自动任务确认',
      message: '是否创建这个持久自动任务？',
      detail:
        'Agent：' + payload.backend +
        '\\n计划：' + zero3ScheduleDescription(payload.schedule) +
        '\\n首次执行：' + payload.firstRunAt +
        '\\n任务：' + payload.goal.slice(0, 1200),
      buttons: ['取消', '创建自动任务'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (confirmation.response !== 1) {
      throw new Error('已取消创建自动任务')
    }

    response = await postZero3AgentSchedule(payload, true)
  }

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  const result = (await response.json()) as { schedule_id?: unknown }
  if (typeof result.schedule_id !== 'string' || !result.schedule_id) {
    throw new Error('Zero3 Node returned an invalid schedule id')
  }
  return { schedule_id: result.schedule_id }
}

ipcMain.handle('zero3:schedule:create-agent', async (_event, request: unknown) => {
  return createZero3AgentSchedule(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'capability-scoped Zero3 schedule preload bridge',
      from: `contextBridge.exposeInMainWorld('zero3Memory', {
  put: request => ipcRenderer.invoke('zero3:memory:put', request)
})`,
      to: `contextBridge.exposeInMainWorld('zero3Memory', {
  put: request => ipcRenderer.invoke('zero3:memory:put', request)
})

contextBridge.exposeInMainWorld('zero3Schedule', {
  createAgent: request => ipcRenderer.invoke('zero3:schedule:create-agent', request)
})`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 schedule renderer types after memory types',
      from: `    zero3Memory: {
      put: (request: {
        key: string
        value: unknown
        class: 'operational' | 'personal'
        scope:
          | { kind: 'global' }
          | { kind: 'session'; session_id: string }
          | { kind: 'thread'; thread_id: string }
      }) => Promise<{ ok: true }>
    }
  }
}`,
      to: `    zero3Memory: {
      put: (request: {
        key: string
        value: unknown
        class: 'operational' | 'personal'
        scope:
          | { kind: 'global' }
          | { kind: 'session'; session_id: string }
          | { kind: 'thread'; thread_id: string }
      }) => Promise<{ ok: true }>
    }
    zero3Schedule: {
      createAgent: (request: {
        backend: 'codex' | 'claude' | 'hermes'
        goal: string
        schedule:
          | { kind: 'once' }
          | { kind: 'every_seconds'; seconds: number }
          | { kind: 'daily_utc'; hour: number; minute: number }
        firstRunAt: string
      }) => Promise<{ schedule_id: string }>
    }
  }
}`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'Zero3 Schedule panel component before control settings',
      from: `function agentName(value: unknown, index: number) {
  if (typeof value === 'string') return value
  const item = record(value)
  return text(item.name, text(item.id, text(item.backend, 'Agent ' + String(index + 1))))
}

export function Zero3ControlSettings() {`,
      to: `function agentName(value: unknown, index: number) {
  if (typeof value === 'string') return value
  const item = record(value)
  return text(item.name, text(item.id, text(item.backend, 'Agent ' + String(index + 1))))
}

function initialScheduleRun() {
  const value = new Date(Date.now() + 5 * 60 * 1000)
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60 * 1000)
  return local.toISOString().slice(0, 16)
}

function scheduleSpecLabel(value: unknown) {
  const spec = record(value)
  if (spec.kind === 'once') return '单次'
  if (spec.kind === 'every_seconds' && typeof spec.seconds === 'number') {
    const minutes = spec.seconds / 60
    return Number.isInteger(minutes) ? '每 ' + String(minutes) + ' 分钟' : '每 ' + String(spec.seconds) + ' 秒'
  }
  if (spec.kind === 'daily_utc' && typeof spec.hour === 'number' && typeof spec.minute === 'number') {
    return '每日 UTC ' + String(spec.hour).padStart(2, '0') + ':' + String(spec.minute).padStart(2, '0')
  }
  return '未知计划'
}

function Zero3SchedulePanel({
  agents,
  online,
  schedules,
  onCreated
}: {
  agents: unknown[]
  online: boolean
  schedules: unknown[]
  onCreated: () => Promise<void>
}) {
  const [backend, setBackend] = useState('')
  const [goal, setGoal] = useState('')
  const [mode, setMode] = useState<'once' | 'every_seconds' | 'daily_utc'>('once')
  const [firstRun, setFirstRun] = useState(initialScheduleRun)
  const [everyMinutes, setEveryMinutes] = useState('60')
  const [dailyUtc, setDailyUtc] = useState('09:00')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const agentOptions = agents
    .map(agentName)
    .filter(name => name === 'codex' || name === 'claude' || name === 'hermes')

  useEffect(() => {
    if (!backend && agentOptions.length > 0) setBackend(agentOptions[0])
  }, [agentOptions, backend])

  const createSchedule = useCallback(async () => {
    const cleanGoal = goal.trim()
    if (!backend || !cleanGoal || !firstRun) {
      setMessage('请选择 Agent、填写任务，并设置首次执行时间')
      return
    }

    let schedule:
      | { kind: 'once' }
      | { kind: 'every_seconds'; seconds: number }
      | { kind: 'daily_utc'; hour: number; minute: number }

    if (mode === 'every_seconds') {
      const minutes = Number(everyMinutes)
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 44_640) {
        setMessage('重复间隔必须在 1 分钟到 31 天之间')
        return
      }
      schedule = { kind: 'every_seconds', seconds: Math.round(minutes * 60) }
    } else if (mode === 'daily_utc') {
      const [hourText, minuteText] = dailyUtc.split(':')
      const hour = Number(hourText)
      const minute = Number(minuteText)
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        setMessage('请输入有效的 UTC 每日时间')
        return
      }
      schedule = { kind: 'daily_utc', hour, minute }
    } else {
      schedule = { kind: 'once' }
    }

    const firstRunDate = new Date(firstRun)
    if (!Number.isFinite(firstRunDate.getTime()) || firstRunDate.getTime() < Date.now() - 30_000) {
      setMessage('首次执行时间不能早于当前时间')
      return
    }

    setBusy(true)
    setMessage(null)
    try {
      const result = await window.zero3Schedule.createAgent({
        backend: backend as 'codex' | 'claude' | 'hermes',
        goal: cleanGoal,
        schedule,
        firstRunAt: firstRunDate.toISOString()
      })
      setGoal('')
      setFirstRun(initialScheduleRun())
      setMessage('自动任务已创建：' + result.schedule_id)
      await onCreated()
    } catch (nextError) {
      setMessage('创建自动任务失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setBusy(false)
    }
  }, [backend, dailyUtc, everyMinutes, firstRun, goal, mode, onCreated])

  return (
    <div className="mt-7">
      <SectionHeading icon={Settings2} meta="Phase B4" title="自动任务" />
      <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            Agent
            <select
              className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
              disabled={!online || busy || agentOptions.length === 0}
              onChange={event => setBackend(event.target.value)}
              value={backend}
            >
              {agentOptions.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            计划
            <select
              className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
              disabled={!online || busy}
              onChange={event => setMode(event.target.value as 'once' | 'every_seconds' | 'daily_utc')}
              value={mode}
            >
              <option value="once">单次执行</option>
              <option value="every_seconds">固定间隔</option>
              <option value="daily_utc">每日 UTC</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            首次执行
            <input
              className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none"
              disabled={!online || busy}
              onChange={event => setFirstRun(event.target.value)}
              type="datetime-local"
              value={firstRun}
            />
          </label>
          {mode === 'every_seconds' ? (
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              间隔分钟数
              <input
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none"
                disabled={!online || busy}
                max="44640"
                min="1"
                onChange={event => setEveryMinutes(event.target.value)}
                step="1"
                type="number"
                value={everyMinutes}
              />
            </label>
          ) : mode === 'daily_utc' ? (
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              每日时间（UTC）
              <input
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none"
                disabled={!online || busy}
                onChange={event => setDailyUtc(event.target.value)}
                type="time"
                value={dailyUtc}
              />
            </label>
          ) : (
            <div className="rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2 text-xs leading-5 text-muted-foreground">
              单次计划执行后会自动停用。
            </div>
          )}
        </div>
        <label className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
          任务目标
          <textarea
            className="min-h-24 resize-y rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-2 text-sm leading-5 text-foreground outline-none"
            disabled={!online || busy}
            maxLength={20000}
            onChange={event => setGoal(event.target.value)}
            placeholder="描述这个 Agent 在计划时间需要完成的任务。"
            value={goal}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-xs leading-5 text-muted-foreground">
            创建持久自动任务必须经过 Electron 原生确认。当前桌面只开放受控 Agent 计划；Browser、Computer 计划以及计划修改/删除仍未开放。
          </p>
          <Button
            disabled={!online || busy || !backend || !goal.trim() || !firstRun}
            onClick={() => void createSchedule()}
            size="sm"
            type="button"
          >
            {busy ? '创建中…' : '创建自动任务'}
          </Button>
        </div>
        {message && (
          <div className="mt-3 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2 text-xs leading-5">
            {message}
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-2">
        {schedules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-(--ui-stroke-secondary) px-3 py-4 text-xs text-muted-foreground">
            当前没有自动任务。
          </div>
        ) : (
          schedules.slice(0, 12).map((value, index) => {
            const item = record(value)
            const enabled = item.enabled === true
            return (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2" key={text(item.id, String(index))}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{text(item.job_kind, '任务')}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {scheduleSpecLabel(item.schedule)} · 下次 {text(item.next_run_at, '—')}
                  </div>
                </div>
                <Pill tone={enabled ? 'primary' : 'warn'}>{enabled ? '启用' : '停用'}</Pill>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function Zero3ControlSettings() {`
    },
    {
      label: 'Zero3 Schedule panel after Memory panel',
      from: `      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B3 已开放 Zero3 原生 Chat、Agent dispatch 与受控 Memory 写入。个人长期记忆默认拒绝静默落盘，只有 Electron 原生确认后才会批准一次；Schedule、Browser 和 Computer 写操作继续保持关闭，后续按独立白名单与权限策略逐项开放。
      </div>`,
      to: `      <Zero3SchedulePanel
        agents={agents}
        online={online}
        schedules={snapshot?.schedules ?? []}
        onCreated={refresh}
      />

      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B4 已开放受控的 Agent 自动任务创建：renderer 不能指定 URL、HTTP 方法、权限等级或批准位，Electron 主进程只会写入固定的 Zero3 Schedule endpoint，并在 Node 要求提升权限时弹出默认取消的原生确认。计划修改/删除以及 Browser、Computer 自动任务继续保持关闭，等待 Node 侧策略门禁补齐后再开放。
      </div>`
    }
  ])
}
