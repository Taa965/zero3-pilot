import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

import { app, ipcMain } from 'electron'

const execFileAsync = promisify(execFile)
const MAX_BODY_BYTES = 256 * 1024
const ROUTE_TIMEOUT_MS = 10 * 60_000

type RobotChannel = 'weixin' | 'qq'
type RobotBackend = 'zero3' | 'codex' | 'claude'

type PublicApiProfile = { id: string; name: string; model: string }
type ChannelSettings = {
  enabled: boolean
  defaultBackend: RobotBackend
  zero3ProfileId: string | null
}

type SessionState = {
  zero3ThreadId?: string
  codexThreadId?: string
  claudeSessionId?: string
}

type RobotState = {
  version: 2
  channels: Record<RobotChannel, ChannelSettings>
  sessions: Record<string, SessionState>
}

export type Zero3RobotDependencies = {
  listZero3Profiles: () => Promise<PublicApiProfile[]>
  runZero3: (profileId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>
  runCodex: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  runClaude: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  defaultCwd: () => string
}

const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  enabled: true,
  defaultBackend: 'zero3',
  zero3ProfileId: null
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'zero3', 'robot-runtime-v2.json')
}

function defaultState(): RobotState {
  return {
    version: 2,
    channels: {
      weixin: { ...DEFAULT_CHANNEL_SETTINGS },
      qq: { ...DEFAULT_CHANNEL_SETTINGS }
    },
    sessions: {}
  }
}

function readState(): RobotState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<RobotState>
    if (parsed.version !== 2) return defaultState()
    const fallback = defaultState()
    return {
      version: 2,
      channels: {
        weixin: normalizeChannelSettings(parsed.channels?.weixin, fallback.channels.weixin),
        qq: normalizeChannelSettings(parsed.channels?.qq, fallback.channels.qq)
      },
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    }
  } catch {
    return defaultState()
  }
}

function normalizeChannelSettings(value: unknown, fallback: ChannelSettings): ChannelSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const backend = record.defaultBackend
  return {
    enabled: record.enabled !== false,
    defaultBackend: backend === 'codex' || backend === 'claude' || backend === 'zero3' ? backend : fallback.defaultBackend,
    zero3ProfileId: typeof record.zero3ProfileId === 'string' && record.zero3ProfileId.trim()
      ? record.zero3ProfileId.trim()
      : null
  }
}

function writeState(state: RobotState): void {
  const file = statePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform === 'win32' && fs.existsSync(file)) fs.rmSync(file, { force: true })
  fs.renameSync(temporary, file)
}

function updateChannelSettings(channel: RobotChannel, patch: Partial<ChannelSettings>): ChannelSettings {
  const state = readState()
  const next = normalizeChannelSettings({ ...state.channels[channel], ...patch }, state.channels[channel])
  state.channels[channel] = next
  writeState(state)
  return next
}

function resolveWeixinExecutable(): string {
  const configured = process.env.ZERO3_WEIXIN_BIN?.trim()
  const bundled = app.isPackaged && process.platform === 'win32'
    ? path.join(process.resourcesPath, 'zero3-weixin', 'zero3-pilot-weixin.exe')
    : ''
  const executable = configured || bundled
  if (!executable) throw new Error('Zero3 微信机器人程序未配置。请重新启动 Zero3 Pilot。')
  if (app.isPackaged && executable !== bundled) throw new Error('已打包的 Zero3 Pilot 只能启动内置微信机器人程序。')
  if (!fs.existsSync(executable)) throw new Error(`微信机器人程序不存在：${executable}`)
  return executable
}

function resolveQqBridgeScript(): string {
  const configured = process.env.ZERO3_QQBOT_BRIDGE?.trim()
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'zero3-robots', 'qqbot_bridge.py') : ''
  const script = configured || bundled
  if (!script || !fs.existsSync(script)) throw new Error('Zero3 QQ 机器人桥接程序不存在。')
  return script
}

function resolveHermesRoot(): string {
  const explicit = process.env.ZERO3_QQBOT_HERMES_ROOT?.trim() || process.env.HERMES_DESKTOP_HERMES_ROOT?.trim()
  if (explicit && fs.existsSync(explicit)) return explicit
  const home = process.env.HERMES_HOME?.trim() || process.env.ZERO3_HERMES_HOME?.trim()
  const candidate = home ? path.join(home, 'hermes-agent') : ''
  if (candidate && fs.existsSync(candidate)) return candidate
  throw new Error('未找到 QQBot 所需的固定 Hermes 传输运行时。')
}

function resolveQqPython(): string {
  const configured = process.env.ZERO3_QQBOT_PYTHON?.trim()
  if (configured && fs.existsSync(configured)) return configured
  const root = resolveHermesRoot()
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, 'venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python'), path.join(root, 'venv', 'bin', 'python')]
  const found = candidates.find(candidate => fs.existsSync(candidate))
  if (!found) throw new Error('未找到包含 QQBot 依赖的 Hermes Python 环境。')
  return found
}

async function runJsonCommand(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: env ?? process.env
  })
  try {
    const value = JSON.parse(stdout.trim())
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    throw new Error('机器人状态返回了无法解析的数据。')
  }
}

function qqEnvironment(): NodeJS.ProcessEnv {
  const root = resolveHermesRoot()
  const currentPythonPath = process.env.PYTHONPATH?.trim()
  return {
    ...process.env,
    ZERO3_QQBOT_HERMES_ROOT: root,
    PYTHONPATH: currentPythonPath ? `${root}${path.delimiter}${currentPythonPath}` : root
  }
}

async function weixinCliStatus(): Promise<Record<string, unknown>> {
  return runJsonCommand(resolveWeixinExecutable(), ['status'])
}

async function qqCliStatus(): Promise<Record<string, unknown>> {
  return runJsonCommand(resolveQqPython(), [resolveQqBridgeScript(), 'status'], qqEnvironment())
}

function boundFromStatus(channel: RobotChannel, status: Record<string, unknown>): boolean {
  const value = status[channel]
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).connected === true)
}

let gatewayUrl = ''
const gatewayToken = randomBytes(32).toString('hex')
let gatewayServer: http.Server | null = null
const children: Record<RobotChannel, ChildProcess | null> = { weixin: null, qq: null }
const stopping: Record<RobotChannel, boolean> = { weixin: false, qq: false }
const serviceErrors: Record<RobotChannel, string | null> = { weixin: null, qq: null }

function tokenMatches(header: string | undefined): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const left = Buffer.from(presented)
  const right = Buffer.from(gatewayToken)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(response: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.byteLength),
    'cache-control': 'no-store'
  })
  response.end(encoded)
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunkValue of request) {
    const chunk = Buffer.from(chunkValue)
    bytes += chunk.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('Robot Gateway 请求过大')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Robot Gateway 请求格式错误')
  return parsed as Record<string, unknown>
}

function routeString(value: unknown, label: string, max = 128_000): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} 无效`)
  return text
}

function routeBackend(value: unknown): RobotBackend {
  if (value === 'zero3' || value === 'codex' || value === 'claude') return value
  throw new Error('不支持的机器人处理器')
}

function routeChannel(value: unknown): RobotChannel {
  if (value === 'weixin' || value === 'qq') return value
  throw new Error('不支持的机器人通道')
}

function sessionKey(body: Record<string, unknown>, channel: RobotChannel): string {
  const sender = routeString(body.sender_id, 'sender_id', 1024)
  const chat = typeof body.chat_id === 'string' && body.chat_id.trim() ? body.chat_id.trim() : sender
  const thread = typeof body.thread_id === 'string' && body.thread_id.trim() ? body.thread_id.trim() : '-'
  return `${channel}:${chat}:${thread}:${sender}`.slice(0, 4096)
}

function sessionFor(state: RobotState, key: string): SessionState {
  const current = state.sessions[key]
  return current && typeof current === 'object' ? current : {}
}

async function routeZero3(
  deps: Zero3RobotDependencies,
  channel: RobotChannel,
  body: Record<string, unknown>,
  state: RobotState,
  key: string
): Promise<Record<string, unknown>> {
  const profiles = await deps.listZero3Profiles()
  if (!profiles.length) throw new Error('尚未配置 Zero3 API Profile，请先在 Zero3 会话中配置模型。')
  const settings = state.channels[channel]
  const profile = profiles.find(item => item.id === settings.zero3ProfileId) ?? profiles[0]
  if (!profile) throw new Error('找不到可用的 Zero3 API Profile')
  const session = sessionFor(state, key)
  const result = await deps.runZero3(profile.id, {
    text: routeString(body.text, 'text'),
    cwd: deps.defaultCwd(),
    projectId: `robot-${channel}`,
    threadId: session.zero3ThreadId ?? null,
    history: []
  })
  if (typeof result.threadId === 'string' && result.threadId.trim()) session.zero3ThreadId = result.threadId.trim()
  state.sessions[key] = session
  writeState(state)
  return { ...result, backend: 'zero3', profileId: profile.id, profileName: profile.name, model: result.model ?? profile.model }
}

async function routeElevated(
  deps: Zero3RobotDependencies,
  backend: Exclude<RobotBackend, 'zero3'>,
  body: Record<string, unknown>,
  state: RobotState,
  key: string
): Promise<Record<string, unknown>> {
  if (body.approved !== true) {
    const error = new Error(`${backend} Agent 执行可能访问或修改本机/项目资源，需要授权码批准当前操作。`)
    ;(error as Error & { approvalRequired?: boolean }).approvalRequired = true
    throw error
  }
  const session = sessionFor(state, key)
  const common = { text: routeString(body.text, 'text'), cwd: deps.defaultCwd() }
  const result = backend === 'codex'
    ? await deps.runCodex({ ...common, threadId: session.codexThreadId ?? null })
    : await deps.runClaude({ ...common, sessionId: session.claudeSessionId ?? null })
  if (backend === 'codex' && typeof result.threadId === 'string' && result.threadId.trim()) {
    session.codexThreadId = result.threadId.trim()
  }
  if (backend === 'claude' && typeof result.sessionId === 'string' && result.sessionId.trim()) {
    session.claudeSessionId = result.sessionId.trim()
  }
  state.sessions[key] = session
  writeState(state)
  return { ...result, backend }
}

async function handleRoute(deps: Zero3RobotDependencies, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const channel = routeChannel(body.channel)
  const backend = routeBackend(body.backend)
  const state = readState()
  const key = sessionKey(body, channel)
  return backend === 'zero3'
    ? routeZero3(deps, channel, body, state, key)
    : routeElevated(deps, backend, body, state, key)
}

async function startGateway(deps: Zero3RobotDependencies): Promise<string> {
  if (gatewayUrl) return gatewayUrl
  gatewayServer = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/route') {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      if (!tokenMatches(request.headers.authorization)) {
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const result = await Promise.race([
          handleRoute(deps, body),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Robot route timed out')), ROUTE_TIMEOUT_MS))
        ])
        sendJson(response, 200, result)
      } catch (error) {
        const approvalRequired = Boolean((error as Error & { approvalRequired?: boolean })?.approvalRequired)
        sendJson(response, approvalRequired ? 428 : 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    gatewayServer?.once('error', reject)
    gatewayServer?.listen(0, '127.0.0.1', () => resolve())
  })
  const address = gatewayServer.address()
  if (!address || typeof address === 'string') throw new Error('Robot Gateway 未能绑定本地端口')
  gatewayUrl = `http://127.0.0.1:${address.port}`
  return gatewayUrl
}

function logFile(channel: RobotChannel): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `robot-${channel}.log`)
}

function serviceEnvironment(channel: RobotChannel, settings: ChannelSettings): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(channel === 'qq' ? qqEnvironment() : {}),
    ZERO3_ROBOT_GATEWAY_URL: gatewayUrl,
    ZERO3_ROBOT_GATEWAY_TOKEN: gatewayToken,
    ...(channel === 'weixin' ? { ZERO3_WEIXIN_AGENT: settings.defaultBackend } : { ZERO3_QQBOT_AGENT: settings.defaultBackend })
  }
}

function spawnService(channel: RobotChannel, settings: ChannelSettings): void {
  if (children[channel] && children[channel]?.exitCode == null) return
  const logFd = fs.openSync(logFile(channel), 'a')
  const env = serviceEnvironment(channel, settings)
  const child = channel === 'weixin'
    ? spawn(resolveWeixinExecutable(), ['run', settings.defaultBackend], {
        env, windowsHide: true, stdio: ['ignore', logFd, logFd]
      })
    : spawn(resolveQqPython(), [resolveQqBridgeScript(), 'run'], {
        env, windowsHide: true, stdio: ['ignore', logFd, logFd]
      })
  fs.closeSync(logFd)
  children[channel] = child
  serviceErrors[channel] = null
  child.once('error', error => {
    if (children[channel] === child) children[channel] = null
    serviceErrors[channel] = error instanceof Error ? error.message : String(error)
    console.error(`[Zero3 Robot] ${channel} service failed to start`, error)
  })
  child.once('exit', (code, signal) => {
    if (children[channel] === child) children[channel] = null
    if (stopping[channel]) return
    if (code !== 0) serviceErrors[channel] = `消息服务异常退出（code=${String(code)}, signal=${signal ?? 'none'}）`
    const current = readState().channels[channel]
    if (!current.enabled) return
    setTimeout(() => {
      void channelStatus(channel).then(status => {
        if (boundFromStatus(channel, status)) spawnService(channel, current)
      }).catch(error => {
        serviceErrors[channel] = error instanceof Error ? error.message : String(error)
      })
    }, 3000)
  })
}

async function stopService(channel: RobotChannel): Promise<void> {
  stopping[channel] = true
  try {
    const child = children[channel]
    if (child && child.exitCode == null) child.kill()
    children[channel] = null
  } finally {
    stopping[channel] = false
  }
}

async function rawChannelStatus(channel: RobotChannel): Promise<Record<string, unknown>> {
  return channel === 'weixin' ? weixinCliStatus() : qqCliStatus()
}

async function channelStatus(channel: RobotChannel): Promise<Record<string, unknown>> {
  const raw = await rawChannelStatus(channel)
  const settings = readState().channels[channel]
  if (gatewayUrl && settings.enabled && boundFromStatus(channel, raw) && !(children[channel] && children[channel]?.exitCode == null)) {
    spawnService(channel, settings)
  }
  return {
    ...raw,
    service_running: Boolean(children[channel] && children[channel]?.exitCode == null),
    service_error: serviceErrors[channel],
    settings
  }
}

async function setServiceEnabled(channel: RobotChannel, enabled: boolean): Promise<Record<string, unknown>> {
  const settings = updateChannelSettings(channel, { enabled })
  if (!enabled) {
    serviceErrors[channel] = null
    await stopService(channel)
  } else {
    serviceErrors[channel] = null
    const status = await rawChannelStatus(channel)
    if (boundFromStatus(channel, status)) spawnService(channel, settings)
  }
  return channelStatus(channel)
}

async function updateSettings(channel: RobotChannel, value: unknown): Promise<ChannelSettings> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const patch: Partial<ChannelSettings> = {}
  if (record.defaultBackend !== undefined) patch.defaultBackend = routeBackend(record.defaultBackend)
  if (record.zero3ProfileId === null || typeof record.zero3ProfileId === 'string') {
    patch.zero3ProfileId = typeof record.zero3ProfileId === 'string' && record.zero3ProfileId.trim() ? record.zero3ProfileId.trim() : null
  }
  const next = updateChannelSettings(channel, patch)
  if (children[channel] && children[channel]?.exitCode == null) {
    await stopService(channel)
    if (next.enabled) spawnService(channel, next)
  }
  return next
}

async function launchWeixinBindingWindow(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('当前微信绑定启动器只支持 Windows。')
  const executable = resolveWeixinExecutable()
  const workingDirectory = path.dirname(executable)
  const launchScript = "Start-Process -FilePath $env:ZERO3_WEIXIN_LAUNCH_EXE -ArgumentList 'login' -WorkingDirectory $env:ZERO3_WEIXIN_LAUNCH_CWD"
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launchScript], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ZERO3_WEIXIN_LAUNCH_EXE: executable,
      ZERO3_WEIXIN_LAUNCH_CWD: workingDirectory
    },
    timeout: 10_000,
    windowsHide: true
  })
}

async function launchQqBindingWindow(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('当前 QQ 绑定启动器只支持 Windows。')
  const python = resolveQqPython()
  const script = resolveQqBridgeScript()
  const workingDirectory = resolveHermesRoot()
  const launchScript = [
    `$arg='"' + $env:ZERO3_QQBOT_BRIDGE + '" login'`,
    'Start-Process -FilePath $env:ZERO3_QQBOT_PYTHON -ArgumentList $arg -WorkingDirectory $env:ZERO3_QQBOT_HERMES_ROOT'
  ].join(';')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launchScript], {
    cwd: workingDirectory,
    env: {
      ...qqEnvironment(),
      ZERO3_QQBOT_BRIDGE: script,
      ZERO3_QQBOT_PYTHON: python,
      ZERO3_QQBOT_HERMES_ROOT: workingDirectory
    },
    timeout: 10_000,
    windowsHide: true
  })
}

async function launchBinding(channel: RobotChannel): Promise<{ started: true }> {
  updateChannelSettings(channel, { enabled: true })
  if (channel === 'weixin') await launchWeixinBindingWindow()
  else await launchQqBindingWindow()
  return { started: true }
}

async function disconnectChannel(channel: RobotChannel): Promise<{ ok: true }> {
  await stopService(channel)
  updateChannelSettings(channel, { enabled: false })
  if (channel === 'weixin') {
    const executable = resolveWeixinExecutable()
    await execFileAsync(executable, ['disconnect'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  } else {
    await execFileAsync(resolveQqPython(), [resolveQqBridgeScript(), 'disconnect'], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, env: qqEnvironment()
    })
  }
  return { ok: true }
}

const CHANNELS = ['weixin', 'qq'] as const
const IPC_CHANNELS = [
  'zero3:robots:weixin-status', 'zero3:robots:weixin-bind', 'zero3:robots:weixin-disconnect',
  'zero3:robots:weixin-start', 'zero3:robots:weixin-stop',
  'zero3:robots:qq-status', 'zero3:robots:qq-bind', 'zero3:robots:qq-disconnect',
  'zero3:robots:qq-start', 'zero3:robots:qq-stop',
  'zero3:robots:settings', 'zero3:robots:settings-set'
] as const

export function registerWeixinRobotDesktopIpc(deps: Zero3RobotDependencies): () => void {
  const gatewayReady = startGateway(deps)
  void gatewayReady.then(async () => {
    for (const channel of CHANNELS) {
      try { await channelStatus(channel) } catch { /* unbound or dependency missing is normal */ }
    }
  }).catch(error => console.error('[Zero3 Robot] gateway start failed', error))

  ipcMain.handle('zero3:robots:weixin-status', async () => { await gatewayReady; return channelStatus('weixin') })
  ipcMain.handle('zero3:robots:weixin-bind', async () => { await gatewayReady; return launchBinding('weixin') })
  ipcMain.handle('zero3:robots:weixin-disconnect', async () => disconnectChannel('weixin'))
  ipcMain.handle('zero3:robots:weixin-start', async () => { await gatewayReady; return setServiceEnabled('weixin', true) })
  ipcMain.handle('zero3:robots:weixin-stop', async () => setServiceEnabled('weixin', false))

  ipcMain.handle('zero3:robots:qq-status', async () => { await gatewayReady; return channelStatus('qq') })
  ipcMain.handle('zero3:robots:qq-bind', async () => { await gatewayReady; return launchBinding('qq') })
  ipcMain.handle('zero3:robots:qq-disconnect', async () => disconnectChannel('qq'))
  ipcMain.handle('zero3:robots:qq-start', async () => { await gatewayReady; return setServiceEnabled('qq', true) })
  ipcMain.handle('zero3:robots:qq-stop', async () => setServiceEnabled('qq', false))

  ipcMain.handle('zero3:robots:settings', async () => ({
    channels: readState().channels,
    profiles: await deps.listZero3Profiles()
  }))
  ipcMain.handle('zero3:robots:settings-set', async (_event, request: unknown) => {
    const value = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {}
    const channel = routeChannel(value.channel)
    return updateSettings(channel, value)
  })

  return () => {
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel)
    void stopService('weixin')
    void stopService('qq')
    gatewayServer?.close()
    gatewayServer = null
    gatewayUrl = ''
  }
}
