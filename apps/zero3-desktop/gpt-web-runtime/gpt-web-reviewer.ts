import type { WebContents } from 'electron'

export type Zero3GptWebReviewDecisionKind =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'BLOCKED'
  | 'ESCALATE_HUMAN'

export type Zero3GptWebReviewDecision = {
  decision: Zero3GptWebReviewDecisionKind
  findings: Array<Record<string, unknown>>
  requiredFixes: string[]
  optionalSuggestions: string[]
  transport: 'chatgpt-web-accessibility-cdp'
}

export type Zero3GptWebReviewInput = {
  reviewId: string
  taskId: string
  cycle: number
  packet: Record<string, unknown>
  timeoutMs?: number
}

type CdpAxValue = { value?: unknown }
type CdpAxProperty = { name?: string; value?: CdpAxValue }
type CdpAxNode = {
  role?: CdpAxValue
  name?: CdpAxValue
  value?: CdpAxValue
  properties?: CdpAxProperty[]
}

const DEFAULT_TIMEOUT_MS = 240_000
const MIN_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_PACKET_BYTES = 192 * 1024
const MAX_PROMPT_CHARS = 220_000
const PREFIX_ROOT = 'ZERO3_REVIEW_DECISION'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function boundedTimeout(value: unknown) {
  if (value == null) return DEFAULT_TIMEOUT_MS
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < MIN_TIMEOUT_MS || number > MAX_TIMEOUT_MS) {
    throw new Error(`GPT Web reviewer timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}ms`)
  }
  return number
}

function stringArray(value: unknown, max = 200): string[] {
  return array(value)
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, max)
}

function findings(value: unknown): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  for (const item of array(value).slice(0, 200)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      result.push(structuredClone(item as Record<string, unknown>))
    } else if (typeof item === 'string' && item.trim()) {
      result.push({ summary: item.trim() })
    }
  }
  return result
}

function property(node: CdpAxNode, name: string): unknown {
  return node.properties?.find(item => item.name === name)?.value?.value
}

function role(node: CdpAxNode): string {
  return text(node.role?.value).toLowerCase()
}

function nodeValue(node: CdpAxNode): string {
  return text(node.value?.value)
}

function focusedEditable(nodes: CdpAxNode[]): CdpAxNode | null {
  return nodes.find(node => {
    const nodeRole = role(node)
    const editable = property(node, 'editable')
    const focused = property(node, 'focused') === true
    return focused && (nodeRole === 'textbox' || nodeRole === 'searchbox' || editable === true || editable === 'richtext')
  }) ?? null
}

function textualCandidates(nodes: CdpAxNode[]): string[] {
  const candidates: string[] = []
  const flattened: string[] = []
  for (const node of nodes) {
    for (const value of [node.name?.value, node.value?.value]) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed) continue
      candidates.push(trimmed)
      flattened.push(trimmed)
    }
  }
  if (flattened.length) {
    candidates.push(flattened.join('\n'))
    candidates.push(flattened.join(''))
  }
  return candidates
}

function extractBalancedJson(source: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function parseDecision(nodes: CdpAxNode[], prefix: string): Zero3GptWebReviewDecision | null {
  for (const candidate of textualCandidates(nodes)) {
    let cursor = 0
    while (cursor < candidate.length) {
      const marker = candidate.indexOf(prefix, cursor)
      if (marker < 0) break
      const jsonStart = marker + prefix.length
      if (candidate[jsonStart] !== '{') {
        cursor = jsonStart
        continue
      }
      const jsonText = extractBalancedJson(candidate, jsonStart)
      if (!jsonText) break
      let raw: Record<string, unknown>
      try {
        raw = record(JSON.parse(jsonText))
      } catch {
        cursor = jsonStart + 1
        continue
      }
      const decision = text(raw.decision).trim() as Zero3GptWebReviewDecisionKind
      if (!['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED', 'ESCALATE_HUMAN'].includes(decision)) {
        cursor = jsonStart + jsonText.length
        continue
      }
      const requiredFixes = stringArray(raw.requiredFixes)
      if (decision === 'CHANGES_REQUESTED' && requiredFixes.length === 0) {
        cursor = jsonStart + jsonText.length
        continue
      }
      return {
        decision,
        findings: findings(raw.findings),
        requiredFixes,
        optionalSuggestions: stringArray(raw.optionalSuggestions),
        transport: 'chatgpt-web-accessibility-cdp'
      }
    }
  }
  return null
}

function reviewPrompt(input: Zero3GptWebReviewInput, nonce: string): { prompt: string; prefix: string } {
  const serializedPacket = JSON.stringify(input.packet)
  if (Buffer.byteLength(serializedPacket, 'utf8') > MAX_PACKET_BYTES) {
    throw new Error(`ReviewPacket exceeds GPT Web reviewer transport limit (${MAX_PACKET_BYTES} bytes)`)
  }
  const prefix = `${PREFIX_ROOT}::${nonce}::`
  const prompt = [
    '你是 Zero3 Pilot 的最终代码审核者。请使用本 ChatGPT 会话已有的项目上下文，并结合下面这份权威 ReviewPacket 进行严格审核。',
    '审核原则：',
    '1. 只有在目标、约束、变更范围与验证证据足够支持通过时才 APPROVED。',
    '2. 有明确可修复问题时用 CHANGES_REQUESTED，并把每条必改项写入 requiredFixes。',
    '3. 证据不足、无法可靠判断或需要人工确认时用 ESCALATE_HUMAN；不要编造你没有看到的代码、测试或 Git 事实。',
    '4. 如果结果本身被阻塞且无法通过同一执行者返工解决，可用 BLOCKED。',
    '5. 不要输出 Markdown、代码围栏或解释文字。只输出一行结果。',
    `输出前缀必须是：${prefix}`,
    '前缀后必须立刻跟一个紧凑 JSON 对象，字段固定为 decision、findings、requiredFixes、optionalSuggestions。',
    'decision 只能是 APPROVED、CHANGES_REQUESTED、BLOCKED、ESCALATE_HUMAN 之一。',
    `Review ID: ${input.reviewId}`,
    `Task ID: ${input.taskId}`,
    `Cycle: ${input.cycle}`,
    `ReviewPacket: ${serializedPacket}`
  ].join('\n')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('GPT Web reviewer prompt exceeds transport limit')
  return { prompt, prefix }
}

async function axTree(contents: WebContents): Promise<CdpAxNode[]> {
  const result = await contents.debugger.sendCommand('Accessibility.getFullAXTree') as { nodes?: CdpAxNode[] }
  return Array.isArray(result.nodes) ? result.nodes : []
}

async function click(contents: WebContents, x: number, y: number) {
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function focusComposer(contents: WebContents, width: number, height: number): Promise<CdpAxNode> {
  const xs = [0.5, 0.56, 0.44]
  const ys = [height - 88, height - 124, height - 164, Math.round(height * 0.82)]
  for (const yRaw of ys) {
    const y = Math.max(24, Math.min(height - 24, yRaw))
    for (const ratio of xs) {
      const x = Math.max(24, Math.min(width - 24, Math.round(width * ratio)))
      await click(contents, x, y)
      await sleep(100)
      const focused = focusedEditable(await axTree(contents))
      if (focused) return focused
    }
  }
  throw new Error('GPT Web reviewer could not focus the ChatGPT composer through the accessibility tree')
}

async function pressEnter(contents: WebContents) {
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  })
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  })
}

export async function runZero3GptWebReview(
  contents: WebContents,
  viewport: { width: number; height: number },
  input: Zero3GptWebReviewInput
): Promise<Zero3GptWebReviewDecision> {
  if (contents.isDestroyed()) throw new Error('GPT Web reviewer WebContents is unavailable')
  if (contents.debugger.isAttached()) {
    throw new Error('GPT Web reviewer cannot start while another Chromium debugger client is attached')
  }
  const width = Math.max(640, Math.round(viewport.width))
  const height = Math.max(480, Math.round(viewport.height))
  const timeoutMs = boundedTimeout(input.timeoutMs)
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const { prompt, prefix } = reviewPrompt(input, nonce)

  contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Accessibility.enable')
    await contents.debugger.sendCommand('Page.bringToFront')

    const composer = await focusComposer(contents, width, height)
    const draft = nodeValue(composer).trim()
    if (draft) {
      throw new Error('GPT Web reviewer found an existing unsent ChatGPT draft and refused to overwrite it')
    }

    await contents.debugger.sendCommand('Input.insertText', { text: prompt })
    await pressEnter(contents)

    const deadline = Date.now() + timeoutMs
    let sawSubmittedPrompt = false
    while (Date.now() < deadline) {
      const nodes = await axTree(contents)
      const allText = textualCandidates(nodes).join('\n')
      if (!sawSubmittedPrompt && allText.includes(input.reviewId) && allText.includes(input.taskId)) {
        sawSubmittedPrompt = true
      }
      const decision = parseDecision(nodes, prefix)
      if (decision) return decision
      await sleep(sawSubmittedPrompt ? 900 : 300)
    }
    if (!sawSubmittedPrompt) {
      throw new Error('GPT Web reviewer could not prove that the ReviewPacket prompt was submitted to ChatGPT')
    }
    throw new Error(`GPT Web reviewer timed out after ${timeoutMs}ms waiting for a structured ReviewDecision`)
  } finally {
    try { await contents.debugger.sendCommand('Accessibility.disable') } catch {}
    if (contents.debugger.isAttached()) contents.debugger.detach()
  }
}
