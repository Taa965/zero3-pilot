import type { WebContents } from 'electron'

const MAX_WAKEUP_TEXT = 2048

function messageText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > MAX_WAKEUP_TEXT) throw new Error(`GPT wakeup message must contain 1..${MAX_WAKEUP_TEXT} characters`)
  return text
}

export async function sendChatGptWakeup(contents: WebContents, messageValue: unknown): Promise<{ sent: true }> {
  if (contents.isDestroyed()) throw new Error('GPT Web view is destroyed')
  const url = new URL(contents.getURL())
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password) {
    throw new Error('GPT wakeup requires a live chatgpt.com page')
  }
  const message = messageText(messageValue)
  const sent = await contents.executeJavaScript(`(async () => {
    const message = ${JSON.stringify(message)}
    const visible = element => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    }
    const editor = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"]')
    if (!(editor instanceof HTMLElement) || !visible(editor)) return false
    editor.focus()
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set
      if (setter) setter.call(editor, message)
      else editor.value = message
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }))
    } else {
      const selection = getSelection()
      selection?.selectAllChildren(editor)
      selection?.deleteFromDocument()
      document.execCommand('insertText', false, message)
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }))
    }
    await new Promise(resolve => setTimeout(resolve, 80))
    const sendSelectors = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[aria-label="发送提示"]',
      'button[aria-label="发送"]'
    ]
    for (const selector of sendSelectors) {
      for (const button of document.querySelectorAll(selector)) {
        if (!(button instanceof HTMLButtonElement) || !visible(button) || button.disabled) continue
        button.click()
        return true
      }
    }
    return false
  })()`, false)
  if (sent !== true) throw new Error('ChatGPT composer/send control is not ready')
  return { sent: true }
}
