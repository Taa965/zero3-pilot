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

export function localTurnRecovery(provider: string, message: string | null): 'model' | 'auth' | null {
  if (!message) return null
  if ((provider === 'codex' || provider === 'claude') && /(?:model.*(?:not supported|not found|does not exist|unavailable)|unsupported model)/i.test(message)) return 'model'
  if ((provider === 'codex' || provider === 'claude') && /(?:failed to authenticate|not logged in|authentication|unauthorized|\b401\b|\b403\b)/i.test(message)) return 'auth'
  // Old Codex errors lost the actual JSON cause. Let the user clear the
  // per-session override without deleting the conversation or guessing a model.
  if (provider === 'codex' && /Reading prompt from stdin/i.test(message)) return 'model'
  return null
}
