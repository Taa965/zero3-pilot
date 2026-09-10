import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveWindowsCommand } from '../executor-runtime/external/windows-command'

export type UsageWindow = { remainingPercent: number | null; resetsAt: string | null }
export type ProviderUsage = {
  status: 'ready' | 'unavailable' | 'unsupported'
  fiveHour: UsageWindow
  weekly: UsageWindow
  balances: Array<{ currency: string; amount: number }>
  checkedAt: string
  detail: string
}
export type UsageRequest = { provider: 'codex' | 'claude' | 'antigravity' | 'zero3'; profileId?: string | null; force?: boolean }
type Profile = { id: string; baseUrl: string; updatedAt: string; apiKey: string | null }
type JsonFetch = (url: string, headers: Record<string, string>, env?: NodeJS.ProcessEnv) => Promise<unknown>
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const emptyWindow = (): UsageWindow => ({ remainingPercent: null, resetsAt: null })
export const emptyUsage = (detail: string, status: ProviderUsage['status'] = 'unavailable'): ProviderUsage => ({
  status, fiveHour: emptyWindow(), weekly: emptyWindow(), balances: [], checkedAt: new Date().toISOString(), detail
})
function remaining(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, 100 - value)) : null
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
export function codexUsage(value: unknown): ProviderUsage {
  const body = record(value)
  const buckets = record(body.rateLimitsByLimitId)
  const limits = record(Object.keys(buckets).length ? buckets.codex : body.rateLimits)
  const result = emptyUsage('Codex 通用额度；额度与其他 Codex 客户端共享')
  for (const raw of [limits.primary, limits.secondary]) {
    const window = record(raw)
    const key = window.windowDurationMins === 300 ? 'fiveHour' : window.windowDurationMins === 10080 ? 'weekly' : null
    if (key) result[key] = { remainingPercent: remaining(window.usedPercent), resetsAt: timestamp(window.resetsAt) }
  }
  if (result.fiveHour.remainingPercent !== null || result.weekly.remainingPercent !== null) result.status = 'ready'
  else result.detail = '当前 Codex 账号未返回 5 小时或周额度'
  return result
}
export function claudeUsage(value: unknown): ProviderUsage {
  const body = record(value)
  const result = emptyUsage('Claude 账号总额度；与官方 Claude 客户端共享')
  for (const [source, key] of [['five_hour', 'fiveHour'], ['seven_day', 'weekly']] as const) {
    const window = record(body[source])
    result[key] = { remainingPercent: remaining(window.utilization), resetsAt: timestamp(window.resets_at) }
  }
  if (result.fiveHour.remainingPercent !== null || result.weekly.remainingPercent !== null) result.status = 'ready'
  else result.detail = 'Claude 未返回该账号的额度信息'
  return result
}
export function balanceEndpoint(baseUrl: string): string | null {
  const url = new URL(baseUrl)
  if (url.username || url.password || url.protocol !== 'https:' || url.port || url.search || url.hash) return null
  // Never forward an API key to a different host, or guess an endpoint for a
  // compatible proxy. These are the providers' documented balance endpoints.
  if (url.hostname === 'api.deepseek.com' && /^\/(?:v1\/?)?$/.test(url.pathname)) return 'https://api.deepseek.com/user/balance'
  if (url.hostname === 'openrouter.ai' && /^\/api\/v1\/?$/.test(url.pathname)) return 'https://openrouter.ai/api/v1/credits'
  return null
}
export function apiBalance(baseUrl: string, value: unknown): ProviderUsage {
  const result = emptyUsage('当前 API 配置所属账户余额')
  const body = record(value)
  if (new URL(baseUrl).hostname === 'api.deepseek.com' && Array.isArray(body.balance_infos)) {
    for (const raw of body.balance_infos) {
      const info = record(raw)
      const amount = typeof info.total_balance === 'string' && info.total_balance.trim() ? Number(info.total_balance) : info.total_balance
      if (typeof amount === 'number' && Number.isFinite(amount) && typeof info.currency === 'string' && /^[A-Z]{3}$/.test(info.currency)) result.balances.push({ currency: info.currency, amount })
    }
  } else if (new URL(baseUrl).hostname === 'openrouter.ai') {
    const data = record(body.data)
    if (typeof data.total_credits === 'number' && Number.isFinite(data.total_credits) && typeof data.total_usage === 'number' && Number.isFinite(data.total_usage)) {
      result.balances.push({ currency: 'USD', amount: data.total_credits - data.total_usage })
    }
  }
  if (result.balances.length) result.status = 'ready'
  else result.detail = '服务商未返回可用余额，不能用请求费用推算余额'
  return result
}

export async function readCodexUsage(env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const cliEnv = { ...env }
  delete cliEnv.CODEX_HOME // Match the local conversation's official CLI identity.
  const resolved = resolveWindowsCommand(env.ZERO3_CODEX_CLI_BIN?.trim() || 'codex')
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.args, 'app-server'], { env: cliEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', bytes = 0, settled = false
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Codex 额度读取超时')), 15_000)
    child.on('error', () => finish(new Error('无法启动本机 Codex 客户端')))
    child.stdin.on('error', () => finish(new Error('Codex 额度连接已关闭')))
    child.on('close', () => finish(new Error('Codex 未返回额度信息')))
    child.stderr.on('data', () => {}) // Do not expose CLI diagnostics/credentials.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 2 * 1024 * 1024) return finish(new Error('Codex 额度响应过大'))
      buffer += chunk
      let newline: number
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message: Record<string, any>
        try { message = record(JSON.parse(line)) } catch { continue }
        if (message.id !== 1 && message.id !== 2) continue
        if (message.error) return finish(new Error('Codex 额度查询失败，请确认官方 CLI 登录及网络状态'))
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
          child.stdin.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }) + '\n')
        } else finish(null, message.result)
      }
    })
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'zero3_usage', version: '1.0.0' } } }) + '\n')
  })
}

export async function readClaudeUsage(fetchJson: JsonFetch, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  let settings: Record<string, any> = {}
  try { settings = record(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))) } catch { /* optional */ }
  const effective = { ...env, ...record(settings.env) } as NodeJS.ProcessEnv
  if (effective.ANTHROPIC_API_KEY || effective.ANTHROPIC_AUTH_TOKEN || (effective.ANTHROPIC_BASE_URL && new URL(effective.ANTHROPIC_BASE_URL).origin !== 'https://api.anthropic.com') || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => effective[key] === '1')) {
    throw new Error('当前 Claude 使用 API 或外部服务，无法读取订阅额度')
  }
  let token = effective.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) {
    try {
      const credentials = record(JSON.parse(await readFile(path.join(directory, '.credentials.json'), 'utf8')))
      token = record(credentials.claudeAiOauth).accessToken
    } catch { /* Do not expose credential paths or file contents. */ }
  }
  if (typeof token !== 'string' || !token) throw new Error('未找到 Claude 官方登录，暂不可获取额度')
  return fetchJson('https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, effective)
}

export function createProviderUsageService(deps: {
  fetchJson: JsonFetch
  profile: (id: string) => Promise<Profile | null>
  codex?: () => Promise<unknown>
  claude?: () => Promise<unknown>
  now?: () => number
}) {
  const cache = new Map<string, { at: number; value: ProviderUsage }>()
  const pending = new Map<string, Promise<ProviderUsage>>()
  const now = deps.now ?? Date.now
  return async (request: UsageRequest): Promise<ProviderUsage> => {
    let profile: Profile | null = null
    if (request.provider === 'zero3') {
      if (!request.profileId) return emptyUsage('该会话尚未绑定 API 配置')
      profile = await deps.profile(request.profileId)
      if (!profile) return emptyUsage('API 配置不存在')
    }
    const key = JSON.stringify([request.provider, profile?.id, profile?.updatedAt, profile?.baseUrl])
    const previous = cache.get(key)
    if (previous && now() - previous.at < (request.force ? 30_000 : previous.value.status === 'ready' ? 300_000 : 60_000)) return previous.value
    if (pending.has(key)) return pending.get(key)!
    const work = (async () => {
      let result: ProviderUsage
      try {
        if (request.provider === 'codex') result = codexUsage(await (deps.codex ?? readCodexUsage)())
        else if (request.provider === 'claude') result = claudeUsage(await (deps.claude ?? (() => readClaudeUsage(deps.fetchJson)))())
        else if (request.provider === 'antigravity') result = emptyUsage('当前 agy CLI 仅提供交互式 /usage 额度面板，未提供可读取的 5 小时与周额度接口', 'unsupported')
        else {
          const endpoint = balanceEndpoint(profile!.baseUrl)
          if (!endpoint) result = emptyUsage('当前 API 服务商暂未接入余额查询，请在服务商控制台查看', 'unsupported')
          else if (!profile!.apiKey) result = emptyUsage('API 配置未提供余额查询所需的 Key')
          else result = apiBalance(profile!.baseUrl, await deps.fetchJson(endpoint, { Authorization: `Bearer ${profile!.apiKey}` }))
        }
      } catch (error) {
        // Only errors authored by our adapters are returned; fetchJson never
        // forwards response bodies, keys, or raw network error messages.
        result = emptyUsage(error instanceof Error ? error.message : '额度暂不可获取')
      }
      cache.set(key, { at: now(), value: result })
      if (cache.size > 100) cache.delete(cache.keys().next().value!)
      return result
    })().finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
}
