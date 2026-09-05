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
        `Zero3 browser bridge drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source or preceding Zero3 overlays changed; review the browser overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3BrowserBridge() {
  patchFile('electron/main.ts', [
    {
      label: 'capability-scoped Zero3 Browser IPC',
      from: `ipcMain.handle('zero3:schedule:set-enabled', async (_event, request: unknown) => {
  return setZero3ScheduleEnabled(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`,
      to: `ipcMain.handle('zero3:schedule:set-enabled', async (_event, request: unknown) => {
  return setZero3ScheduleEnabled(request)
})

type Zero3BrowserAction =
  | { action: 'launch'; executable: null; headless: false }
  | { action: 'navigate'; url: string }
  | { action: 'snapshot' }
  | { action: 'close' }

type Zero3BrowserSnapshotElement = {
  reference: string
  tag: string
  role: string
  name: string
  text: string
  enabled: boolean
  visible: boolean
}

type Zero3BrowserSnapshot = {
  url: string
  title: string
  text: string
  elements: Zero3BrowserSnapshotElement[]
}

function zero3BrowserRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function zero3BrowserText(value: unknown, limit = 4096) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function parseZero3BrowserUrl(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 Browser navigation payload must be an object')
  }
  const payload = value as Record<string, unknown>
  const raw = typeof payload.url === 'string' ? payload.url.trim() : ''
  if (!raw || raw.length > 4096) {
    throw new Error('Zero3 Browser URL is required and must be at most 4096 characters')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Zero3 Browser URL must be valid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Zero3 Browser only allows http and https navigation')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Zero3 Browser URLs must not embed credentials')
  }
  return parsed.toString()
}

async function postZero3Browser(action: Zero3BrowserAction): Promise<string> {
  const response = await fetch(ZERO3_NODE_BASE + '/api/v1/jobs/browser', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      action,
      granted_level: 'Standard',
      approved: false
    }),
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  const accepted = zero3BrowserRecord(await response.json())
  const jobId = zero3BrowserText(accepted.job_id, 128)
  if (!jobId) throw new Error('Zero3 Browser dispatch did not return a job id')
  return jobId
}

async function waitForZero3BrowserJob(jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    const jobs = await readZero3Node('jobs')
    if (!Array.isArray(jobs)) {
      throw new Error('Zero3 Node jobs response is not an array')
    }

    const match = jobs
      .map(zero3BrowserRecord)
      .find(job => zero3BrowserText(job.id, 128) === jobId)

    if (match) {
      const status = zero3BrowserText(match.status, 32)
      if (status === 'Succeeded') {
        const output = zero3BrowserRecord(match.output)
        if (output.ok !== true) throw new Error('Zero3 Browser job returned a non-success result')
        return zero3BrowserRecord(output.detail)
      }
      if (status === 'Failed') {
        throw new Error(zero3BrowserText(match.error, 4000) || 'Zero3 Browser job failed')
      }
      if (status === 'Cancelled') {
        throw new Error('Zero3 Browser job was cancelled')
      }
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error('Zero3 Browser action timed out after 60 seconds')
}

async function runZero3Browser(action: Zero3BrowserAction) {
  const jobId = await postZero3Browser(action)
  return waitForZero3BrowserJob(jobId)
}

function sanitizeZero3BrowserSnapshot(detail: Record<string, unknown>): Zero3BrowserSnapshot {
  const elements = Array.isArray(detail.elements) ? detail.elements : []
  return {
    url: zero3BrowserText(detail.url, 4096),
    title: zero3BrowserText(detail.title, 1000),
    text: zero3BrowserText(detail.text, 40_000),
    elements: elements.slice(0, 100).map(value => {
      const item = zero3BrowserRecord(value)
      return {
        reference: zero3BrowserText(item.reference, 512),
        tag: zero3BrowserText(item.tag, 64),
        role: zero3BrowserText(item.role, 128),
        name: zero3BrowserText(item.name, 1000),
        text: zero3BrowserText(item.text, 2000),
        enabled: item.enabled === true,
        visible: item.visible === true
      }
    })
  }
}

ipcMain.handle('zero3:browser:launch', async () => {
  return runZero3Browser({ action: 'launch', executable: null, headless: false })
})

ipcMain.handle('zero3:browser:navigate', async (_event, request: unknown) => {
  const url = parseZero3BrowserUrl(request)
  const detail = await runZero3Browser({ action: 'navigate', url })
  return { url: zero3BrowserText(detail.url, 4096) }
})

ipcMain.handle('zero3:browser:snapshot', async () => {
  return sanitizeZero3BrowserSnapshot(await runZero3Browser({ action: 'snapshot' }))
})

ipcMain.handle('zero3:browser:close', async () => {
  return runZero3Browser({ action: 'close' })
})

ipcMain.handle('hermes:notify', (_event, payload) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'capability-scoped Zero3 Browser preload bridge',
      from: `contextBridge.exposeInMainWorld('zero3Schedule', {
  createAgent: request => ipcRenderer.invoke('zero3:schedule:create-agent', request),
  setEnabled: request => ipcRenderer.invoke('zero3:schedule:set-enabled', request)
})`,
      to: `contextBridge.exposeInMainWorld('zero3Schedule', {
  createAgent: request => ipcRenderer.invoke('zero3:schedule:create-agent', request),
  setEnabled: request => ipcRenderer.invoke('zero3:schedule:set-enabled', request)
})

contextBridge.exposeInMainWorld('zero3Browser', {
  launch: () => ipcRenderer.invoke('zero3:browser:launch'),
  navigate: request => ipcRenderer.invoke('zero3:browser:navigate', request),
  snapshot: () => ipcRenderer.invoke('zero3:browser:snapshot'),
  close: () => ipcRenderer.invoke('zero3:browser:close')
})`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 Browser renderer types',
      from: `    zero3Schedule: {
      createAgent: (request: {
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
    }
  }
}`,
      to: `    zero3Schedule: {
      createAgent: (request: {
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
    }
    zero3Browser: {
      launch: () => Promise<Record<string, unknown>>
      navigate: (request: { url: string }) => Promise<{ url: string }>
      snapshot: () => Promise<{
        url: string
        title: string
        text: string
        elements: Array<{
          reference: string
          tag: string
          role: string
          name: string
          text: string
          enabled: boolean
          visible: boolean
        }>
      }>
      close: () => Promise<Record<string, unknown>>
    }
  }
}`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'Zero3 Browser control panel',
      from: `export function Zero3ControlSettings() {`,
      to: `function Zero3BrowserPanel({ online }: { online: boolean }) {
  const [url, setUrl] = useState('https://example.com')
  const [busy, setBusy] = useState<'launch' | 'navigate' | 'snapshot' | 'close' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{
    url: string
    title: string
    text: string
    elements: Array<{ reference: string; role: string; name: string; text: string }>
  } | null>(null)

  const launch = useCallback(async () => {
    setBusy('launch')
    setMessage(null)
    try {
      await window.zero3Browser.launch()
      setMessage('受控浏览器已启动')
    } catch (nextError) {
      setMessage('启动浏览器失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setBusy(null)
    }
  }, [])

  const navigate = useCallback(async () => {
    const nextUrl = url.trim()
    if (!nextUrl) {
      setMessage('请输入 http 或 https 地址')
      return
    }
    setBusy('navigate')
    setMessage(null)
    try {
      const result = await window.zero3Browser.navigate({ url: nextUrl })
      setMessage('已打开：' + result.url)
    } catch (nextError) {
      setMessage('打开地址失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setBusy(null)
    }
  }, [url])

  const readPage = useCallback(async () => {
    setBusy('snapshot')
    setMessage(null)
    try {
      const result = await window.zero3Browser.snapshot()
      setSnapshot(result)
      setMessage('页面语义快照已更新')
    } catch (nextError) {
      setMessage('读取页面失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setBusy(null)
    }
  }, [])

  const close = useCallback(async () => {
    setBusy('close')
    setMessage(null)
    try {
      await window.zero3Browser.close()
      setSnapshot(null)
      setMessage('受控浏览器已关闭')
    } catch (nextError) {
      setMessage('关闭浏览器失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setBusy(null)
    }
  }, [])

  return (
    <div className="mt-7">
      <SectionHeading icon={Settings2} meta="Phase B5a" title="浏览器" />
      <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
        <div className="flex flex-wrap gap-2">
          <Button disabled={!online || busy !== null} onClick={() => void launch()} size="sm" type="button" variant="outline">
            {busy === 'launch' ? '启动中…' : '启动受控浏览器'}
          </Button>
          <Button disabled={!online || busy !== null} onClick={() => void readPage()} size="sm" type="button" variant="outline">
            {busy === 'snapshot' ? '读取中…' : '读取页面'}
          </Button>
          <Button disabled={!online || busy !== null} onClick={() => void close()} size="sm" type="button" variant="outline">
            {busy === 'close' ? '关闭中…' : '关闭浏览器'}
          </Button>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="h-9 min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none"
            disabled={!online || busy !== null}
            maxLength={4096}
            onChange={event => setUrl(event.target.value)}
            placeholder="https://example.com"
            value={url}
          />
          <Button disabled={!online || busy !== null || !url.trim()} onClick={() => void navigate()} size="sm" type="button">
            {busy === 'navigate' ? '打开中…' : '打开地址'}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          这一阶段只开放启动、http/https 导航、语义读取和关闭。点击、输入、按键与脚本执行仍未暴露给 renderer。
        </p>
        {message && (
          <div className="mt-3 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2 text-xs leading-5">
            {message}
          </div>
        )}
        {snapshot && (
          <div className="mt-3 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3">
            <div className="text-sm font-medium">{snapshot.title || '无标题页面'}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{snapshot.url}</div>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              {snapshot.text || '页面没有可读取文本。'}
            </pre>
            <div className="mt-2 text-xs text-muted-foreground">语义元素：{snapshot.elements.length}</div>
          </div>
        )}
      </div>
    </div>
  )
}

export function Zero3ControlSettings() {`
    },
    {
      label: 'Zero3 Browser panel after schedule lifecycle',
      from: `      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B4c 已开放受控的 Agent 自动任务创建、暂停与恢复：暂停是减少未来副作用的 Standard 操作；恢复必须由 Zero3 Node 返回 428 后经过 Electron 原生确认。renderer 仍不能指定 URL、HTTP 方法、权限等级或批准位；不可逆删除以及 Browser、Computer 自动任务继续保持关闭。
      </div>`,
      to: `      <Zero3BrowserPanel online={online} />

      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B5a 已开放最小 Browser 原生能力：Electron 只提供启动、http/https 导航、语义快照与关闭四个专用 IPC，所有实际动作仍由 Zero3 Node BrowserProvider 执行。点击、输入、按键、Evaluate、Browser 自动任务以及 Computer 写操作继续保持关闭。
      </div>`
    }
  ])
}
