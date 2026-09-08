/** Only observed ChatGPT project page titles contain a project prefix.
 * Explicit user names must never be shortened. */
export function webSessionTitle(entry: {
  kind: string
  localDisplayTitle: string | null
  pageTitle: string | null
  conversationUrl: string | null
  currentUrl: string
}): string {
  if (entry.localDisplayTitle) return entry.localDisplayTitle
  const title = entry.pageTitle?.trim()
  if (!title) return entry.kind === 'gpt_web' ? '新 GPT 网页会话' : '新 Gemini 网页会话'
  if (entry.kind === 'gpt_web') {
    try {
      const url = new URL(entry.conversationUrl ?? entry.currentUrl)
      if (url.hostname === 'chatgpt.com' && /^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(url.pathname)) {
        const separator = title.indexOf(' - ')
        if (separator > 0 && title.slice(separator + 3).trim()) return title.slice(separator + 3).trim()
      }
    } catch { /* Preserve the observed title when the URL is not recognisable. */ }
  }
  return title
}
