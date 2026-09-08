import type { WebContents } from 'electron'

export function chatGptConversationId(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password) throw new Error('会话地址不是 ChatGPT 网页地址')
  const match = url.pathname.match(/^\/(?:g\/g-p-[^/]+\/)?c\/([A-Za-z0-9_-]{1,128})\/?$/)
  if (!match) throw new Error('请先在 GPT 网页中发送消息，生成会话后再修改名称')
  return match[1]
}

/** Runs inside the signed-in ChatGPT origin. Credentials never cross IPC. */
export function chatGptRenameScript(conversationUrl: string, title: string): string {
  const id = chatGptConversationId(conversationUrl)
  const normalized = typeof title === 'string' ? title.trim() : ''
  if (!normalized || normalized.length > 200) throw new Error('名称需为 1–200 个字符')
  return `(async () => {
    const { id, title } = ${JSON.stringify({ id, title: normalized })};
    if (location.origin !== 'https://chatgpt.com') throw new Error('请先登录 ChatGPT 网页后重试');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let saved = false;
    try {
      const options = { credentials: 'include', redirect: 'error', signal: controller.signal };
      const auth = await fetch('/api/auth/session', options);
      const session = auth.ok ? await auth.json() : null;
      if (!session || typeof session.accessToken !== 'string' || !session.accessToken) throw new Error('请先在零三中登录 ChatGPT 网页后重试');
      const headers = { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' };
      const endpoint = '/backend-api/conversation/' + encodeURIComponent(id);
      const response = await fetch(endpoint, { ...options, headers, method: 'PATCH', body: JSON.stringify({ title }) });
      if (!response.ok) throw new Error('ChatGPT 网页保存失败（HTTP ' + response.status + '）');
      saved = true;
      const verification = await fetch(endpoint, { ...options, headers, cache: 'no-store' });
      if (!verification.ok) throw new Error('ChatGPT 名称复核失败（HTTP ' + verification.status + '）');
      const conversation = await verification.json();
      if (conversation.title !== title) throw new Error('ChatGPT 返回的名称与提交名称不一致');
      return { title: conversation.title };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '同步请求超时，请检查网页后重试'
        : error instanceof Error ? error.message : '同步请求失败';
      throw new Error((saved ? '网页已接受修改，但尚未完成复核；零三名称未保存。' : '') + message);
    } finally { clearTimeout(timer); }
  })()`
}

export async function renameChatGptConversation(
  contents: Pick<WebContents, 'executeJavaScript'>,
  conversationUrl: string,
  title: string
): Promise<void> {
  const result: unknown = await contents.executeJavaScript(chatGptRenameScript(conversationUrl, title), false)
  if (!result || typeof result !== 'object' || !('title' in result) || result.title !== title.trim()) {
    throw new Error('ChatGPT 未确认名称已保存，零三名称未修改')
  }
}
