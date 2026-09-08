import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 session-provider overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const mainRuntime = String.raw`
type Zero3SessionProviderId = 'gpt' | 'gemini' | 'codex' | 'claude' | 'antigravity' | 'zero3'
type Zero3ApiProfileProtocol = 'openai_compatible' | 'anthropic' | 'google_gemini'
type Zero3ApiProfileStored = {
  id: string
  name: string
  protocol: Zero3ApiProfileProtocol
  baseUrl: string
  model: string
  encryptedApiKey: string | null
  createdAt: string
  updatedAt: string
}
type Zero3ApiProfileState = { version: 1; profiles: Record<string, Zero3ApiProfileStored> }
const ZERO3_API_PROFILE_FILE = path.join(app.getPath('userData'), 'zero3', 'api-profiles-v1.json')
const ZERO3_API_TIMEOUT_MS = 10 * 60_000
const ZERO3_API_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

function zero3SessionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function zero3SessionText(value: unknown, label: string, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(label + ' is required and must be at most ' + String(max) + ' characters')
  return text
}
function zero3SessionOptionalText(value: unknown, max = 4096): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error('value must be a string or null')
  const text = value.trim()
  if (!text || text.length > max) throw new Error('value is too long')
  return text
}
function zero3SessionProvider(value: unknown): Zero3SessionProviderId {
  const provider = zero3SessionText(value, 'provider', 32)
  if (!['gpt', 'gemini', 'codex', 'claude', 'antigravity', 'zero3'].includes(provider)) throw new Error('unsupported session provider')
  return provider as Zero3SessionProviderId
}
function zero3SessionSafeBaseUrl(value: unknown): string {
  const raw = zero3SessionText(value, 'baseUrl', 4096)
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('baseUrl must be a valid URL') }
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('baseUrl must use HTTPS unless it targets localhost')
  }
  if (parsed.username || parsed.password) throw new Error('baseUrl must not embed credentials')
  return parsed.toString().replace(/\/$/, '')
}
async function zero3ApiProfileRead(): Promise<Zero3ApiProfileState> {
  const fsp = await import('node:fs/promises')
  try {
    const parsed = JSON.parse(await fsp.readFile(ZERO3_API_PROFILE_FILE, 'utf8')) as Partial<Zero3ApiProfileState>
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object') throw new Error('invalid Zero3 API profile state')
    return { version: 1, profiles: parsed.profiles as Record<string, Zero3ApiProfileStored> }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} }
    throw error
  }
}
async function zero3ApiProfileWrite(state: Zero3ApiProfileState): Promise<void> {
  const fsp = await import('node:fs/promises')
  await fsp.mkdir(path.dirname(ZERO3_API_PROFILE_FILE), { recursive: true })
  const temporary = ZERO3_API_PROFILE_FILE + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36)
  await fsp.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, ZERO3_API_PROFILE_FILE)
}
async function zero3EncryptApiKey(apiKey: string): Promise<string> {
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，Zero3 不会明文保存 API Key')
  return safeStorage.encryptString(apiKey).toString('base64')
}
async function zero3DecryptApiKey(value: string | null): Promise<string | null> {
  if (!value) return null
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取 API Key')
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}
function zero3PublicApiProfile(profile: Zero3ApiProfileStored) {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: Boolean(profile.encryptedApiKey),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}
async function zero3ListApiProfiles() {
  const state = await zero3ApiProfileRead()
  return Object.values(state.profiles).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(zero3PublicApiProfile)
}
function zero3ApiProtocol(value: unknown): Zero3ApiProfileProtocol {
  if (value !== 'openai_compatible' && value !== 'anthropic' && value !== 'google_gemini') throw new Error('unsupported Zero3 API protocol')
  return value
}
function zero3Endpoint(baseUrl: string, suffix: string): string {
  return baseUrl.replace(/\/$/, '') + '/' + suffix.replace(/^\//, '')
}
function zero3MessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    const item = zero3SessionRecord(part)
    return typeof item.text === 'string' ? item.text : ''
  }).filter(Boolean).join('\n')
}
function zero3Messages(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 60) throw new Error('messages must contain 1-60 items')
  return value.map((raw, index) => {
    const item = zero3SessionRecord(raw)
    const role = item.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error('message ' + String(index + 1) + ' has an invalid role')
    return { role, content: zero3SessionText(item.content, 'message content', 20_000) }
  })
}
async function zero3FetchJson(url: string, init: Parameters<typeof fetch>[1]): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ZERO3_API_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > ZERO3_API_MAX_RESPONSE_BYTES) throw new Error('API response exceeded the 16 MiB limit')
    let parsed: unknown = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { throw new Error('API returned non-JSON data: ' + text.slice(0, 500)) }
    const body = zero3SessionRecord(parsed)
    if (!response.ok) {
      const error = zero3SessionRecord(body.error)
      const message = typeof error.message === 'string' ? error.message : text.slice(0, 500)
      throw new Error('API HTTP ' + String(response.status) + ': ' + message)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}
async function zero3ApiTurn(profile: Zero3ApiProfileStored, messagesValue: unknown) {
  const messages = zero3Messages(messagesValue)
  const apiKey = await zero3DecryptApiKey(profile.encryptedApiKey)
  if (profile.protocol === 'openai_compatible') {
    const body = await zero3FetchJson(zero3Endpoint(profile.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {})
      },
      body: JSON.stringify({ model: profile.model, messages, stream: false })
    })
    const choices = Array.isArray(body.choices) ? body.choices : []
    const choice = zero3SessionRecord(choices[0])
    const message = zero3SessionRecord(choice.message)
    const text = zero3MessageText(message.content)
    if (!text.trim()) throw new Error('OpenAI-compatible API returned no assistant text')
    return { text, model: profile.model, profileId: profile.id }
  }
  if (profile.protocol === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic profile requires an API Key')
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
    const body = await zero3FetchJson(zero3Endpoint(profile.baseUrl, profile.baseUrl.endsWith('/v1') ? 'messages' : 'v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: messages.filter(message => message.role !== 'system')
      })
    })
    const text = zero3MessageText(body.content)
    if (!text.trim()) throw new Error('Anthropic API returned no assistant text')
    return { text, model: profile.model, profileId: profile.id }
  }
  if (!apiKey) throw new Error('Google Gemini profile requires an API Key')
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const contents = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }))
  const url = zero3Endpoint(profile.baseUrl, 'models/' + encodeURIComponent(profile.model) + ':generateContent') + '?key=' + encodeURIComponent(apiKey)
  const body = await zero3FetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) })
  })
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const content = zero3SessionRecord(zero3SessionRecord(candidates[0]).content)
  const text = zero3MessageText(content.parts)
  if (!text.trim()) throw new Error('Gemini API returned no assistant text')
  return { text, model: profile.model, profileId: profile.id }
}
async function zero3RunClaudeTurn(requestValue: unknown) {
  const request = zero3SessionRecord(requestValue)
  const text = zero3SessionText(request.text, 'Claude prompt', 128_000)
  const cwd = zero3SessionOptionalText(request.cwd, 4096)
  const sessionId = zero3SessionOptionalText(request.sessionId, 512)
  const command = process.env.ZERO3_CLAUDE_BIN?.trim() || 'claude'
  const args = ['-p', text, '--output-format', 'json', '--permission-mode', 'dontAsk']
  if (sessionId) args.push('--resume', sessionId)
  const { spawn } = await import('node:child_process')
  return new Promise<{ text: string; sessionId: string | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Claude CLI turn timed out after 10 minutes'))
    }, ZERO3_API_TIMEOUT_MS)
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > ZERO3_API_MAX_RESPONSE_BYTES) {
        child.kill()
        reject(new Error('Claude CLI output exceeded 16 MiB'))
        return
      }
      target.push(Buffer.from(chunk))
    }
    child.stdout.on('data', chunk => capture(stdout, Buffer.from(chunk)))
    child.stderr.on('data', chunk => capture(stderr, Buffer.from(chunk)))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const output = Buffer.concat(stdout).toString('utf8')
      const errorOutput = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) return reject(new Error(errorOutput.trim() || output.trim() || 'Claude CLI exited with code ' + String(code)))
      let parsed: Record<string, unknown>
      try { parsed = zero3SessionRecord(JSON.parse(output)) } catch { return reject(new Error('Claude CLI returned invalid JSON')) }
      const result = typeof parsed.result === 'string' ? parsed.result.trim() : ''
      if (!result) return reject(new Error('Claude CLI returned no assistant text'))
      const nextSessionId = typeof parsed.session_id === 'string' && parsed.session_id.trim() ? parsed.session_id.trim() : sessionId
      resolve({ text: result, sessionId: nextSessionId })
    })
  })
}
async function zero3OpenProviderAuthorization(provider: Zero3SessionProviderId) {
  if (provider === 'gpt' || provider === 'gemini') return { opened: false, detail: '网页会话会直接打开官方登录页' }
  if (provider === 'zero3') return { opened: false, detail: 'Zero3 本体使用 API Profile，不需要 CLI 登录' }
  if (process.platform !== 'win32') return { opened: false, detail: '当前自动打开授权终端仅支持 Windows，请在系统终端完成官方 CLI 登录' }
  const command = provider === 'codex' ? 'codex login' : provider === 'claude' ? 'claude auth login' : 'agy'
  const { spawn } = await import('node:child_process')
  const comspec = process.env.ComSpec || 'cmd.exe'
  const child = spawn(comspec, ['/d', '/s', '/c', 'start "" cmd.exe /k "' + command + '"'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return { opened: true, detail: '已打开官方 CLI 授权终端；完成登录后回到 Zero3 点击刷新状态' }
}
async function zero3SessionProviderStatus() {
  let codexAvailable = false
  let codexAuthenticated: boolean | null = null
  let codexDetail = 'Codex app-server 不可用'
  try {
    await zero3CodexAppServer.ensureStarted()
    codexAvailable = true
    try {
      const accountRead = zero3SessionRecord(await zero3CodexAppServer.request('account/read', { refreshToken: false }))
      const account = zero3SessionRecord(accountRead.account)
      const type = typeof account.type === 'string' ? account.type : ''
      codexAuthenticated = type === 'chatgpt'
      codexDetail = codexAuthenticated ? '已复用本机 Codex 的 ChatGPT 登录' : 'Codex 已安装，但尚未完成 ChatGPT 登录'
    } catch (error) {
      codexAuthenticated = false
      codexDetail = error instanceof Error ? error.message : String(error)
    }
  } catch (error) {
    codexDetail = error instanceof Error ? error.message : String(error)
  }

  const claude = await zero3ClaudeTaskAdapter.availability()
  const agy = zero3Antigravity.status()
  let antigravityAuthenticated: boolean | null = null
  let sawAuthFailure = false
  for (const logicalSessionId of agy.activeSessions) {
    try {
      const binding = await zero3Antigravity.binding(logicalSessionId)
      if (binding?.authState === 'AUTHENTICATED') {
        antigravityAuthenticated = true
        break
      }
      if (binding?.authState === 'AUTH_REQUIRED' || binding?.authState === 'AUTH_EXPIRED') sawAuthFailure = true
    } catch {}
  }
  if (antigravityAuthenticated !== true && sawAuthFailure) antigravityAuthenticated = false
  const profiles = await zero3ListApiProfiles()

  return {
    gpt: { available: true, authenticated: null, authMode: 'web' as const, detail: '使用内嵌 ChatGPT 官方网页登录' },
    gemini: { available: true, authenticated: null, authMode: 'web' as const, detail: '使用内嵌 Gemini 官方网页登录' },
    codex: { available: codexAvailable, authenticated: codexAuthenticated, authMode: 'cli' as const, detail: codexDetail },
    claude: {
      available: claude.available,
      authenticated: claude.authenticated,
      authMode: 'cli' as const,
      detail: !claude.available ? '未检测到 Claude Code CLI' : claude.authenticated === true ? '已复用本机 Claude Code 登录' : 'Claude Code 已安装但未授权'
    },
    antigravity: {
      available: agy.available,
      authenticated: antigravityAuthenticated,
      authMode: 'cli' as const,
      detail: !agy.available ? '未检测到 Antigravity CLI (agy)' : antigravityAuthenticated === true ? '已验证 Antigravity 授权' : antigravityAuthenticated === false ? 'Antigravity 授权已失效或缺失' : '已安装；首次启动会验证官方授权'
    },
    zero3: {
      available: true,
      authenticated: profiles.length > 0 ? true : false,
      authMode: 'api_profile' as const,
      detail: profiles.length > 0 ? '已配置 ' + String(profiles.length) + ' 个 API 模型' : '尚未配置 API 模型'
    }
  }
}

ipcMain.handle('zero3:session-providers:status', () => zero3SessionProviderStatus())
ipcMain.handle('zero3:session-providers:authorize', (_event, request: unknown) => zero3OpenProviderAuthorization(zero3SessionProvider(zero3SessionRecord(request).provider)))
ipcMain.handle('zero3:session-providers:zero3-profiles:list', () => zero3ListApiProfiles())
ipcMain.handle('zero3:session-providers:zero3-profiles:save', async (_event, requestValue: unknown) => {
  const request = zero3SessionRecord(requestValue)
  const id = zero3SessionText(request.id, 'profile id', 128)
  const state = await zero3ApiProfileRead()
  const existing = state.profiles[id]
  const protocol = zero3ApiProtocol(request.protocol)
  const apiKey = zero3SessionOptionalText(request.apiKey, 8192)
  const timestamp = new Date().toISOString()
  const profile: Zero3ApiProfileStored = {
    id,
    name: zero3SessionText(request.name, 'profile name', 128),
    protocol,
    baseUrl: zero3SessionSafeBaseUrl(request.baseUrl),
    model: zero3SessionText(request.model, 'model', 256),
    encryptedApiKey: apiKey ? await zero3EncryptApiKey(apiKey) : existing?.encryptedApiKey ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  if ((protocol === 'anthropic' || protocol === 'google_gemini') && !profile.encryptedApiKey) {
    throw new Error('该 API 协议需要 API Key')
  }
  state.profiles[id] = profile
  await zero3ApiProfileWrite(state)
  return zero3PublicApiProfile(profile)
})
ipcMain.handle('zero3:session-providers:zero3-profiles:remove', async (_event, requestValue: unknown) => {
  const request = zero3SessionRecord(requestValue)
  const id = zero3SessionText(request.id, 'profile id', 128)
  const state = await zero3ApiProfileRead()
  const removed = Boolean(state.profiles[id])
  delete state.profiles[id]
  if (removed) await zero3ApiProfileWrite(state)
  return { removed }
})
ipcMain.handle('zero3:session-providers:zero3-turn', async (_event, requestValue: unknown) => {
  const request = zero3SessionRecord(requestValue)
  const profileId = zero3SessionText(request.profileId, 'profileId', 128)
  const state = await zero3ApiProfileRead()
  const profile = state.profiles[profileId]
  if (!profile) throw new Error('Zero3 API Profile 不存在')
  return zero3ApiTurn(profile, request.messages)
})
ipcMain.handle('zero3:session-providers:claude-turn', (_event, request: unknown) => zero3RunClaudeTurn(request))
`

const preloadSurface = String.raw`contextBridge.exposeInMainWorld('zero3SessionProviders', {
  status: () => ipcRenderer.invoke('zero3:session-providers:status'),
  authorize: request => ipcRenderer.invoke('zero3:session-providers:authorize', request),
  listZero3Profiles: () => ipcRenderer.invoke('zero3:session-providers:zero3-profiles:list'),
  saveZero3Profile: request => ipcRenderer.invoke('zero3:session-providers:zero3-profiles:save', request),
  removeZero3Profile: request => ipcRenderer.invoke('zero3:session-providers:zero3-profiles:remove', request),
  zero3Turn: request => ipcRenderer.invoke('zero3:session-providers:zero3-turn', request),
  claudeTurn: request => ipcRenderer.invoke('zero3:session-providers:claude-turn', request)
})

contextBridge.exposeInMainWorld('zero3AgentTask', {`

const globalTypes = String.raw`
type Zero3SessionProviderId = 'gpt' | 'gemini' | 'codex' | 'claude' | 'antigravity' | 'zero3'
type Zero3SessionProviderStatus = {
  available: boolean
  authenticated: boolean | null
  authMode: 'web' | 'cli' | 'api_profile'
  detail: string
}
type Zero3SessionProviderStatusMap = Record<Zero3SessionProviderId, Zero3SessionProviderStatus>
type Zero3ApiProfileProtocol = 'openai_compatible' | 'anthropic' | 'google_gemini'
type Zero3ApiProfile = {
  id: string
  name: string
  protocol: Zero3ApiProfileProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}
`

const globalSurface = String.raw`    zero3SessionProviders: {
      status: () => Promise<Zero3SessionProviderStatusMap>
      authorize: (request: { provider: Zero3SessionProviderId }) => Promise<{ opened: boolean; detail: string }>
      listZero3Profiles: () => Promise<Zero3ApiProfile[]>
      saveZero3Profile: (request: { id: string; name: string; protocol: Zero3ApiProfileProtocol; baseUrl: string; model: string; apiKey?: string | null }) => Promise<Zero3ApiProfile>
      removeZero3Profile: (request: { id: string }) => Promise<{ removed: boolean }>
      zero3Turn: (request: { profileId: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> }) => Promise<{ text: string; model: string; profileId: string }>
      claudeTurn: (request: { text: string; cwd?: string | null; sessionId?: string | null }) => Promise<{ text: string; sessionId: string | null }>
    }
    zero3AgentTask: {`

export function applyZero3SessionProviderRuntime() {
  patchFile('electron/main.ts', [
    {
      label: 'session provider IPC before Agent orchestrator',
      from: 'const zero3AgentRuntime = new Zero3AgentRuntimeOrchestrator({',
      to: mainRuntime + '\nconst zero3AgentRuntime = new Zero3AgentRuntimeOrchestrator({'
    }
  ])
  patchFile('electron/preload.ts', [
    {
      label: 'session provider preload before Agent Task bridge',
      from: "contextBridge.exposeInMainWorld('zero3AgentTask', {",
      to: preloadSurface
    }
  ])
  patchFile('src/global.d.ts', [
    {
      label: 'session provider renderer types',
      from: 'type Zero3AgentTaskTarget =',
      to: globalTypes + '\ntype Zero3AgentTaskTarget ='
    },
    {
      label: 'session provider renderer surface',
      from: '    zero3AgentTask: {',
      to: globalSurface
    }
  ])
}
