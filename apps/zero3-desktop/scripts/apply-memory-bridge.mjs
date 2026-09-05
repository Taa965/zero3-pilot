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
        `Zero3 memory bridge drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source or preceding Zero3 overlays changed; review the memory overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3MemoryBridge() {
  patchFile('electron/main.ts', [
    {
      label: 'native-approved Zero3 memory IPC',
      from: `ipcMain.handle('hermes:ambient:claim', (_event, key) => !claimedAmbientCue(String(key ?? '')))

ipcMain.handle('hermes:notify', (_event, payload) => {`,
      to: `ipcMain.handle('hermes:ambient:claim', (_event, key) => !claimedAmbientCue(String(key ?? '')))

type Zero3MemoryScope =
  | { kind: 'global' }
  | { kind: 'session'; session_id: string }
  | { kind: 'thread'; thread_id: string }

type Zero3MemoryPutPayload = {
  key: string
  value: unknown
  class: 'operational' | 'personal'
  scope: Zero3MemoryScope
}

function parseZero3MemoryScope(value: unknown): Zero3MemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 memory scope must be an object')
  }

  const scope = value as Record<string, unknown>
  if (scope.kind === 'global') return { kind: 'global' }

  if (scope.kind === 'session') {
    const sessionId = typeof scope.session_id === 'string' ? scope.session_id.trim() : ''
    if (!sessionId || sessionId.length > 256) {
      throw new Error('Zero3 session memory requires a scope id up to 256 characters')
    }
    return { kind: 'session', session_id: sessionId }
  }

  if (scope.kind === 'thread') {
    const threadId = typeof scope.thread_id === 'string' ? scope.thread_id.trim() : ''
    if (!threadId || threadId.length > 256) {
      throw new Error('Zero3 thread memory requires a scope id up to 256 characters')
    }
    return { kind: 'thread', thread_id: threadId }
  }

  throw new Error('Zero3 memory scope kind is not allowlisted')
}

function parseZero3MemoryPut(value: unknown): Zero3MemoryPutPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 memory payload must be an object')
  }

  const payload = value as Record<string, unknown>
  const key = typeof payload.key === 'string' ? payload.key.trim() : ''
  if (!key || key.length > 256) {
    throw new Error('Zero3 memory key is required and must be at most 256 characters')
  }

  const memoryClass = payload.class
  if (memoryClass !== 'operational' && memoryClass !== 'personal') {
    throw new Error('Zero3 memory class must be operational or personal')
  }

  if (!Object.hasOwn(payload, 'value')) {
    throw new Error('Zero3 memory value is required')
  }

  let encodedValue: string | undefined
  try {
    encodedValue = JSON.stringify(payload.value)
  } catch {
    throw new Error('Zero3 memory value must be JSON serializable')
  }
  if (encodedValue === undefined) {
    throw new Error('Zero3 memory value must be JSON serializable')
  }
  if (Buffer.byteLength(encodedValue, 'utf8') > 64 * 1024) {
    throw new Error('Zero3 memory value exceeds the 64 KiB desktop limit')
  }

  return {
    key,
    value: payload.value,
    class: memoryClass,
    scope: parseZero3MemoryScope(payload.scope ?? { kind: 'global' })
  }
}

async function postZero3Memory(payload: Zero3MemoryPutPayload, approved: boolean) {
  return fetch(ZERO3_NODE_BASE + '/api/v1/memory', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      key: payload.key,
      value: payload.value,
      class: payload.class,
      scope: payload.scope,
      source: 'zero3-desktop',
      approved
    }),
    signal: AbortSignal.timeout(5000)
  })
}

function zero3MemoryScopeLabel(scope: Zero3MemoryScope) {
  if (scope.kind === 'global') return '全局'
  if (scope.kind === 'session') return '会话 · ' + scope.session_id
  return '线程 · ' + scope.thread_id
}

async function putZero3Memory(value: unknown): Promise<{ ok: true }> {
  const payload = parseZero3MemoryPut(value)
  let response = await postZero3Memory(payload, false)

  if (response.status === 428 && payload.class === 'personal') {
    const preview = JSON.stringify(payload.value).slice(0, 500)
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Zero3 记忆确认',
      message: '是否保存这条个人长期记忆？',
      detail: '键：' + payload.key + '\\n范围：' + zero3MemoryScopeLabel(payload.scope) + '\\n内容：' + preview,
      buttons: ['取消', '批准一次'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (confirmation.response !== 1) {
      throw new Error('已取消保存个人记忆')
    }

    response = await postZero3Memory(payload, true)
  }

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  return { ok: true }
}

ipcMain.handle('zero3:memory:put', async (_event, request: unknown) => {
  return putZero3Memory(request)
})

ipcMain.handle('hermes:notify', (_event, payload) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'capability-scoped Zero3 memory preload bridge',
      from: `  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('hermes:open-find-bar', listener)
  }
})`,
      to: `  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('hermes:open-find-bar', listener)
  }
})

contextBridge.exposeInMainWorld('zero3Memory', {
  put: request => ipcRenderer.invoke('zero3:memory:put', request)
})`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 memory renderer types',
      from: `      onOpenFindBarRequested: (callback: () => void) => () => void
    }
  }
}`,
      to: `      onOpenFindBarRequested: (callback: () => void) => () => void
    }
    zero3Memory: {
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
}`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'Zero3 memory editor state after native chat state',
      from: `  const [chatBusy, setChatBusy] = useState(false)
  const [chatMessages, setChatMessages] = useState<NativeChatMessage[]>(loadNativeChat)

  const refresh = useCallback(async () => {`,
      to: `  const [chatBusy, setChatBusy] = useState(false)
  const [chatMessages, setChatMessages] = useState<NativeChatMessage[]>(loadNativeChat)
  const [memoryKey, setMemoryKey] = useState('')
  const [memoryValue, setMemoryValue] = useState('')
  const [memoryClass, setMemoryClass] = useState<'operational' | 'personal'>('operational')
  const [memoryScope, setMemoryScope] = useState<'global' | 'session' | 'thread'>('global')
  const [memoryScopeId, setMemoryScopeId] = useState('')
  const [savingMemory, setSavingMemory] = useState(false)
  const [memoryMessage, setMemoryMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {`
    },
    {
      label: 'Zero3 memory save callback after native chat callback',
      from: `  }, [chatBackend, chatBusy, chatInput, chatMessages, refresh])

  const browser = record(snapshot?.status.browser)
  const computer = record(snapshot?.status.computer)`,
      to: `  }, [chatBackend, chatBusy, chatInput, chatMessages, refresh])

  const saveMemory = useCallback(async () => {
    const key = memoryKey.trim()
    const raw = memoryValue.trim()
    const scopeId = memoryScopeId.trim()
    if (!key || !raw) {
      setMemoryMessage('请填写记忆键和内容')
      return
    }
    if (memoryScope !== 'global' && !scopeId) {
      setMemoryMessage('会话或线程记忆需要范围 ID')
      return
    }

    let value: unknown = memoryValue
    try {
      value = JSON.parse(raw)
    } catch {
      // Plain text is a valid memory value; JSON is optional.
    }

    const scope =
      memoryScope === 'global'
        ? ({ kind: 'global' } as const)
        : memoryScope === 'session'
          ? ({ kind: 'session', session_id: scopeId } as const)
          : ({ kind: 'thread', thread_id: scopeId } as const)

    setSavingMemory(true)
    setMemoryMessage(null)
    try {
      await window.zero3Memory.put({ key, value, class: memoryClass, scope })
      setMemoryKey('')
      setMemoryValue('')
      setMemoryMessage(memoryClass === 'personal' ? '个人记忆已保存' : '运行记忆已保存')
      await refresh()
    } catch (nextError) {
      setMemoryMessage('保存记忆失败：' + (nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setSavingMemory(false)
    }
  }, [memoryClass, memoryKey, memoryScope, memoryScopeId, memoryValue, refresh])

  const browser = record(snapshot?.status.browser)
  const computer = record(snapshot?.status.computer)`
    },
    {
      label: 'Zero3 memory editor UI after native chat surface',
      from: `      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B2 已建立第一条 Zero3 原生 Chat transport：renderer 只能调用专用 chatTurn IPC，Electron 主进程负责参数校验、原生审批、Agent job 提交与结果等待。当前为非流式闭环；下一切片将加入事件流、停止生成和 Zero3 持久会话，再替换主聊天页的 Hermes compatibility transport。
      </div>`,
      to: `      <div className="mt-7">
        <SectionHeading icon={Settings2} meta="Phase B3" title="记忆写入" />
        <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              记忆键
              <input
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none"
                disabled={!online || savingMemory}
                maxLength={256}
                onChange={event => setMemoryKey(event.target.value)}
                placeholder="例如：project.current_goal"
                value={memoryKey}
              />
            </label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              类型
              <select
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
                disabled={!online || savingMemory}
                onChange={event => setMemoryClass(event.target.value as 'operational' | 'personal')}
                value={memoryClass}
              >
                <option value="operational">运行记忆</option>
                <option value="personal">个人长期记忆（需确认）</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              范围
              <select
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
                disabled={!online || savingMemory}
                onChange={event => setMemoryScope(event.target.value as 'global' | 'session' | 'thread')}
                value={memoryScope}
              >
                <option value="global">全局</option>
                <option value="session">会话</option>
                <option value="thread">线程</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              范围 ID
              <input
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 text-sm text-foreground outline-none disabled:opacity-50"
                disabled={!online || savingMemory || memoryScope === 'global'}
                maxLength={256}
                onChange={event => setMemoryScopeId(event.target.value)}
                placeholder={memoryScope === 'global' ? '全局记忆无需填写' : '输入会话或线程 ID'}
                value={memoryScopeId}
              />
            </label>
          </div>
          <label className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
            内容
            <textarea
              className="min-h-24 resize-y rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-2 text-sm leading-5 text-foreground outline-none"
              disabled={!online || savingMemory}
              onChange={event => setMemoryValue(event.target.value)}
              placeholder="普通文本会按字符串保存；合法 JSON 会按 JSON 值保存。"
              value={memoryValue}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              个人长期记忆必须经过 Electron 原生确认。渲染器不能设置 approved，来源固定为 zero3-desktop。
            </p>
            <Button
              disabled={
                !online ||
                savingMemory ||
                !memoryKey.trim() ||
                !memoryValue.trim() ||
                (memoryScope !== 'global' && !memoryScopeId.trim())
              }
              onClick={() => void saveMemory()}
              size="sm"
              type="button"
            >
              {savingMemory ? '保存中…' : '保存记忆'}
            </Button>
          </div>
          {memoryMessage && (
            <div className="mt-3 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-3 py-2 text-xs leading-5">
              {memoryMessage}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B3 已开放 Zero3 原生 Chat、Agent dispatch 与受控 Memory 写入。个人长期记忆默认拒绝静默落盘，只有 Electron 原生确认后才会批准一次；Schedule、Browser 和 Computer 写操作继续保持关闭，后续按独立白名单与权限策略逐项开放。
      </div>`
    }
  ])
}
