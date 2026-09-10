// Electron's network stack uses the same system proxy as the desktop browser.
// Keep this separate from parsing so account adapters can be tested offline.
export async function fetchUsageJson(url: string, headers: Record<string, string>, env?: NodeJS.ProcessEnv): Promise<unknown> {
  const { session } = await import('electron')
  const connection = session.fromPartition(env ? 'zero3-claude-usage' : 'zero3-api-balance')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const proxy = env?.HTTPS_PROXY ?? env?.https_proxy ?? env?.ALL_PROXY ?? env?.all_proxy ?? env?.HTTP_PROXY ?? env?.http_proxy
    if (proxy) {
      const parsed = new URL(proxy)
      if (parsed.username || parsed.password || !['http:', 'https:', 'socks5:'].includes(parsed.protocol)) throw new Error('proxy')
      await connection.setProxy({ mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: env?.NO_PROXY ?? env?.no_proxy })
    } else await connection.setProxy({ mode: proxy === '' ? 'direct' : 'system' })
    const response = await connection.fetch(url, { headers, signal: controller.signal, redirect: 'error', credentials: 'omit' })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) throw new Error('usage-auth')
      if (response.status === 403) throw new Error('usage-permission')
      if (response.status === 429) throw new Error('usage-rate')
      throw new Error('usage-http')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('usage-body')
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('usage-size') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    if (reason === 'usage-auth') throw new Error('额度查询授权已失效，请在官方客户端确认登录')
    if (reason === 'usage-permission') throw new Error('当前账号或 API Key 无权查询额度/余额，请在官方控制台查看')
    if (reason === 'usage-rate') throw new Error('额度查询暂时限流，请稍后刷新')
    if (reason === 'proxy') throw new Error('额度查询无法使用当前代理配置')
    throw new Error('额度查询暂时失败，请检查网络后刷新')
  } finally { clearTimeout(timer) }
}
