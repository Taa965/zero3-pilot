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
      if (bytes > ZERO3_API_MAX_RESPONSE_BYTES)  {
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
  if (process.platform !== 'win32') return { opened: false, detail: '当前自动打开授权终֊wh���!�'��(�f�v��'^��{(u�e����/�׫rV�u�%j�^j�a��"��2r���Z�