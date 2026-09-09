import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type ProxyResolver = (url: string) => Promise<string>
const PROXY_KEYS = new Set(['http_proxy', 'https_proxy', 'all_proxy'])

function hasProxy(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(key => PROXY_KEYS.has(key.toLowerCase()) && env[key] !== undefined)
}

export function claudeProxyUrl(route: string): string | null {
  // Respect Chromium's first route, including DIRECT. Do not turn a PAC's
  // fallback list into a different routing policy or silently bypass SOCKS.
  const first = route.split(';')[0].trim()
  if (first === 'DIRECT') return null
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first)
  if (!match) throw new Error('Claude 不支持当前系统代理类型；请配置 HTTP/HTTPS 代理。')
  const url = new URL((match[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + match[2])
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('系统代理地址格式无效')
  return url.origin
}

async function configuredEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  try {
    const settings = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))
    return settings.env && typeof settings.env === 'object' ? settings.env : {}
  } catch { return {} }
}

export async function claudeCliEnvironment(options: {
  env?: NodeJS.ProcessEnv
  platform?: string
  settingsEnv?: NodeJS.ProcessEnv
  resolveProxy?: ProxyResolver
} = {}): Promise<NodeJS.ProcessEnv> {
  const env = { ...(options.env ?? process.env) }
  if ((options.platform ?? process.platform) !== 'win32' || hasProxy(env)) return env
  const settingsEnv = options.settingsEnv ?? await configuredEnvironment(env)
  // The CLI applies its own explicit settings. Never replace them with a
  // system-derived default, including an explicitly empty proxy setting.
  if (hasProxy(settingsEnv)) return env
  const effective = { ...env, ...settingsEnv }
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => effective[key] === '1')) return env
  let resolveProxy = options.resolveProxy
  if (!resolveProxy) {
    if (!process.versions.electron) return env
    const { session } = await import('electron')
    resolveProxy = url => session.defaultSession.resolveProxy(url)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const route = await Promise.race([
      resolveProxy(effective.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取系统代理超时，请检查网络代理设置。')), 5000) })
    ])
    const proxy = claudeProxyUrl(route)
    if (proxy) {
      env.HTTPS_PROXY = proxy
      env.HTTP_PROXY = proxy
      if (!Object.keys(effective).some(key => key.toLowerCase() === 'no_proxy')) env.NO_PROXY = 'localhost,127.0.0.1,::1'
    }
    return env
  } finally { clearTimeout(timer) }
}
