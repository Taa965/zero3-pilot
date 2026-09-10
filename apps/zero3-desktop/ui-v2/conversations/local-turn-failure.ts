export function localTurnFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^执行失败：\s*/, '').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
  // Older sessions persisted Claude's entire JSON result in the chat bubble.
  try {
    const start = message.indexOf('{')
    const end = message.lastIndexOf('}')
    const result = JSON.parse(message.slice(start, end + 1))
    if (result.is_error === true && typeof result.result === 'string') {
      return message.slice(0, start) + result.result + message.slice(end + 1)
    }
  } catch {
    // Earlier releases saved only the first 300 characters of stdout. The
    // result/error field is gone; do not infer an authentication cause from it.
    if (/^Claude CLI 执行失败：\s*\{/.test(message)) {
      const logAt = message.indexOf('（完整输出见 ')
      return 'Claude CLI 执行失败：旧版本截断了错误详情，请重新发送以获取具体原因。' + (logAt >= 0 ? message.slice(logAt) : '')
    }
  }
  return message
}

export function localTurnQuotaMessage(provider: string, message: string | null): string | null {
  if (provider !== 'claude' || !message) return null
  const detail = localTurnFailureMessage(message)
  // A plain 429 can mean a short rate limit. Only explicit usage exhaustion
  // warrants telling the user their allowance is used up.
  if (!/(?:you['’]ve hit your (?:(?:session|weekly|usage) )?limit|(?:session|weekly|usage) limit (?:reached|exceeded)|(?:reached|exceeded) your (?:session|weekly|usage) limit)/i.test(detail)) return null
  const scope = /\bsession limit\b/i.test(detail) ? '当前会话' : /\bweekly limit\b/i.test(detail) ? '本周' : '使用'
  // Keep the provider's reset time/timezone verbatim; don't infer a date or
  // promise a countdown from a historical message. Diagnostic logs stay saved.
  const reset = detail.match(/\bresets?\s+([^\r\n]+?)(?=\s*（完整输出见|$)/i)?.[1]?.trim()
  return `Claude ${scope}额度已用完。${reset ? `服务端提示的额度恢复时间：${reset}。` : '请在 Claude 中查看额度恢复时间。'}额度恢复后可在当前会话继续发送。`
}

export function localTurnMessageText(provider: string, message: { role: string; content: string }): string {
  if (message.role !== 'assistant' || !message.content.startsWith('执行失败：')) return message.content
  return localTurnQuotaMessage(provider, message.content) ?? `执行失败：${localTurnFailureMessage(message.content)}`
}

export function localTurnRecovery(provider: string, message: string | null): 'model' | 'auth' | null {
  if (!message) return null
  if (localTurnQuotaMessage(provider, message)) return null
  if ((provider === 'codex' || provider === 'claude') && /(?:model.*(?:not supported|not found|does not exist|unavailable)|unsupported model)/i.test(message)) return 'model'
  if ((provider === 'codex' || provider === 'claude') && /(?:failed to authenticate|not logged in|authentication|unauthorized|\b401\b|\b403\b)/i.test(message)) return 'auth'
  // Old Codex errors lost the actual JSON cause. Let the user clear the
  // per-session override without deleting the conversation or guessing a model.
  if (provider === 'codex' && /Reading prompt from stdin/i.test(message)) return 'model'
  return null
}
