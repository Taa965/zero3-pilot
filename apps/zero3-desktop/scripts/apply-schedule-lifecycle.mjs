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
        `Zero3 schedule lifecycle drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source or preceding Zero3 overlays changed; review the lifecycle overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3ScheduleLifecycle() {
  patchFile('electron/main.ts', [
    {
      label: 'typed Zero3 schedule pause/resume IPC',
      from: `ipcMain.handle('zero3:schedule:create-agent', async (_event, request: unknown) => {
  return createZero3AgentSchedule(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`,
      to: `ipcMain.handle('zero3:schedule:create-agent', async (_event, request: unknown) => {
  return createZero3AgentSchedule(request)
})

type Zero3ScheduleEnabledPayload = {
  scheduleId: string
  enabled: boolean
}

const ZERO3_SCHEDULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseZero3ScheduleEnabled(value: unknown): Zero3ScheduleEnabledPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 schedule lifecycle payload must be an object')
  }

  const payload = value as Record<string, unknown>
  const scheduleId = typeof payload.scheduleId === 'string' ? payload.scheduleId.trim() : ''
  if (!ZERO3_SCHEDULE_ID.test(scheduleId)) {
    throw new Error('Zero3 schedule id must be a UUID')
  }
  if (typeof payload.enabled !== 'boolean') {
    throw new Error('Zero3 schedule enabled state must be boolean')
  }

  return { scheduleId, enabled: payload.enabled }
}

async function patchZero3ScheduleEnabled(payload: Zero3ScheduleEnabledPayload, approved: boolean) {
  return fetch(ZERO3_NODE_BASE + '/api/v1/schedules/' + encodeURIComponent(payload.scheduleId), {
    method: 'PATCH',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      enabled: payload.enabled,
      granted_level: 'Standard',
      approved
    }),
    signal: AbortSignal.timeout(10_000)
  })
}

async function setZero3ScheduleEnabled(value: unknown): Promise<{ schedule_id: string; enabled: boolean }> {
  const payload = parseZero3ScheduleEnabled(value)
  let response = await patchZero3ScheduleEnabled(payload, false)

  if (response.status === 428) {
    if (!payload.enabled) {
      throw new Error('Zero3 Node unexpectedly requires approval to pause an automation')
    }

    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Zero3 自动任务确认',
      message: '是否恢复这个自动任务？',
      detail:
        '任务 ID：' + payload.scheduleId +
        '\\n恢复后，Zero3 Node 会继续按照原计划触发未来执行。',
      buttons: ['取消', '恢复自动任务'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (confirmation.response !== 1) {
      throw new Error('已取消恢复自动任务')
    }

    response = await patchZero3ScheduleEnabled(payload, true)
  }

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  const result = (await response.json()) as { schedule_id?: unknown; enabled?: unknown }
  if (
    result.schedule_id !== payload.scheduleId ||
    typeof result.enabled !== 'boolean' ||
    result.enabled !== payload.enabled
  ) {
    throw new Error('Zero3 Node returned an invalid schedule lifecycle result')
  }

  return { schedule_id: payload.scheduleId, enabled: payload.enabled }
}

ipcMain.handle('zero3:schedule:set-enabled', async (_event, request: unknown) => {
  return setZero3ScheduleEnabled(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'capability-scoped schedule lifecycle preload bridge',
      from: `contextBridge.exposeInMainWorld('zero3Schedule', {
  createAgent: request => ipcRenderer.invoke('zero3:schedule:create-agent', request)
})`,
      to: `contextBridge.exposeInMainWorld('zero3Schedule', {
  createAgent: request => ipcRenderer.invoke('zero3:schedule:create-agent', request),
  setEnabled: request => ipcRenderer.invoke('zero3:schedule:set-enabled', request)
})`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 schedule lifecycle renderer type',
      from: `      createAgent: (request: {
        backend: 'codex' | 'claude' | 'hermes'
        goal: string
        schedule:
          | { kind: 'once' }
          | { kind: 'every_seconds'; seconds: number }
          | { kind: 'daily_utc'; hour: number; minute: number }
        firstRunAt: string
      }) => Promise<{ schedule_id: string }>
    }`,
      to: `      createAgent: (request: {
        backend: 'codex' | 'claude' | 'hermes'
        goal: string
        schedule:
          | { kind: 'once' }
          | { kind: 'every_seconds'; seconds: number }
          | { kind: 'daily_utc'; hour: number; minute: number }
        firstRunAt: string
      }) => Promise<{ schedule_id: string }>
      setEnabled: (request: { scheduleId: string; enabled: boolean }) => Promise<{
        schedule_id: string
        enabled: boolean
      }>
    }`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'schedule lifecycle busy state',
      from: `  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)`,
      to: `  const [busy, setBusy] = useState(false)
  const [changingScheduleId, setChangingScheduleId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)`
    },
    {
      label: 'schedule lifecycle callback',
      from: `  }, [backend, dailyUtc, everyMinutes, firstRun, goal, mode, onCreated])

  return (`,
      to: `  }, [backend, dailyUtc, everyMinutes, firstRun, goal, mode, onCreated])

  const setScheduleEnabled = useCallback(async (scheduleId: string, enabled: boolean) => {
    setChangingScheduleId(scheduleId)
    setMessage(null)
    try {
      await window.zero3Schedule.setEnabled({ scheduleId, enabled })
      setMessage(enabled ? '自动任务已恢复' : '自动任务已暂停')
      await onCreated()
    } catch (nextError) {
      setMessage((enabled ? '恢复' : '暂停') + '自动任务失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setChangingScheduleId(null)
    }
  }, [onCreated])

  return (`
    },
    {
      label: 'schedule lifecycle guidance copy',
      from: `            创建持久自动任务必须经过 Electron 原生确认。当前桌面只开放受控 Agent 计划；Browser、Computer 计划以及计划修改/删除仍未开放。`,
      to: `            创建持久自动任务必须经过 Electron 原生确认。暂停可直接执行；恢复会再次走原生审批。删除以及 Browser、Computer 自动任务仍未开放。`
    },
    {
      label: 'schedule lifecycle row id',
      from: `            const item = record(value)
            const enabled = item.enabled === true
            return (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2" key={text(item.id, String(index))}>`,
      to: `            const item = record(value)
            const enabled = item.enabled === true
            const scheduleId = text(item.id, '')
            return (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2" key={scheduleId || String(index)}>`
    },
    {
      label: 'schedule lifecycle row controls',
      from: `                <Pill tone={enabled ? 'primary' : 'warn'}>{enabled ? '启用' : '停用'}</Pill>`,
      to: `                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={enabled ? 'primary' : 'warn'}>{enabled ? '启用' : '停用'}</Pill>
                  <Button
                    disabled={!online || busy || !scheduleId || changingScheduleId === scheduleId}
                    onClick={() => void setScheduleEnabled(scheduleId, !enabled)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {changingScheduleId === scheduleId ? '处理中…' : enabled ? '暂停' : '恢复'}
                  </Button>
                </div>`
    },
    {
      label: 'Phase B4 lifecycle completion note',
      from: `        Phase B4 已开放受控的 Agent 自动任务创建：renderer 不能指定 URL、HTTP 方法、权限等级或批准位，Electron 主进程只会写入固定的 Zero3 Schedule endpoint，并在 Node 要求提升权限时弹出默认取消的原生确认。计划修改/删除以及 Browser、Computer 自动任务继续保持关闭，等待 Node 侧策略门禁补齐后再开放。`,
      to: `        Phase B4c 已开放受控的 Agent 自动任务创建、暂停与恢复：暂停是减少未来副作用的 Standard 操作；恢复必须由 Zero3 Node 返回 428 后经过 Electron 原生确认。renderer 仍不能指定 URL、HTTP 方法、权限等级或批准位；不可逆删除以及 Browser、Computer 自动任务继续保持关闭。`
    }
  ])
}
