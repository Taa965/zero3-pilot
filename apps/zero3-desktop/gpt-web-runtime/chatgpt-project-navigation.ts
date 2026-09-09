import type { WebContents } from 'electron'
import { readChatGptProjectCatalog } from './chatgpt-project-catalog'

export function chatGptProjectId(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null
    return url.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?\/project\/?$/)?.[1] ?? null
  } catch { return null }
}

// A cold project page currently gates rendering on locked_chats/status, which
// can return 404 even for ordinary projects. Enter through the site's home and
// populated sidebar, just as a user does. Keep all authentication/lock checks
// in ChatGPT; never synthesize API responses or change its feature flags.
export async function loadChatGptProject(contents: WebContents, target: string): Promise<void> {
  const id = chatGptProjectId(target)
  if (!id) throw new Error('Invalid ChatGPT project URL')
  await contents.loadURL('https://chatgpt.com/')
  const projects = await readChatGptProjectCatalog(contents.session, contents)
  const project = projects.find(project => project.id === id)
  if (!project) throw new Error('当前 ChatGPT 账号中未找到此项目，请检查项目绑定')

  const result = await contents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 20000
    let openedSidebar = false
    while (Date.now() < deadline) {
      if (location.origin !== 'https://chatgpt.com' || location.pathname !== '/') return false
      const router = window.__reactRouterDataRouter
      if (!openedSidebar && !document.querySelector('[data-testid="project-folder-icon"]')) {
        const button = document.querySelector('[data-testid="open-sidebar-button"], button[aria-label="打开侧边栏"], button[aria-label="Open sidebar"]')
        if (button) { button.click(); openedSidebar = true }
      }
      if (document.querySelector('#prompt-textarea') &&
          document.querySelector('[data-testid="project-folder-icon"]') &&
          router && typeof router.navigate === 'function') {
        await router.navigate(${JSON.stringify(new URL(project.url).pathname)}, { replace: true })
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  })()`, false)
  if (result !== true) throw new Error('ChatGPT 项目入口未就绪，请刷新重试')

  const ready = await contents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (location.origin !== 'https://chatgpt.com' || !location.pathname.startsWith('/g/' + ${JSON.stringify(id)})) return false
      if (document.querySelector('#prompt-textarea')) return true
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  })()`, false)
  if (ready !== true) throw new Error('ChatGPT 项目未能显示，请检查网页中的重试或访问权限提示')
}
