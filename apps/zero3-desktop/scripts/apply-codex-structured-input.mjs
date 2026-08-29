import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'
import { applyZero3CodexStructuredInputHardening } from './apply-codex-structured-input-hardening.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Codex R3C structured-input drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3C transport/presentation adapter before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const structuredInputParser = String.raw`const ZERO3_CODEX_MAX_TURN_INPUTS = 32

function zero3CodexTurnInput(value: unknown, index: number): Record<string, unknown> {
  const input = zero3CodexRecord(value)
  const type = zero3CodexRequiredString(input.type, 'input[' + String(index) + '].type', 32)

  if (type === 'text') {
    return {
      type: 'text',
      text: zero3CodexRequiredString(input.text, 'input[' + String(index) + '].text', 100_000),
      text_elements: []
    }
  }

  if (type === 'localImage') {
    return {
      type: 'localImage',
      path: zero3CodexRequiredString(input.path, 'input[' + String(index) + '].path', 4096)
    }
  }

  throw new Error('input[' + String(index) + '].type must be text or localImage')
}

function zero3CodexTurnInputs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('input must be an array')
  if (value.length < 1 || value.length > ZERO3_CODEX_MAX_TURN_INPUTS) {
    throw new Error('input must contain between 1 and ' + String(ZERO3_CODEX_MAX_TURN_INPUTS) + ' items')
  }
  return value.map((entry, index) => zero3CodexTurnInput(entry, index))
}

function zero3CodexTurnStartParams(value: unknown) {`

const structuredTurnStart = String.raw`function zero3CodexTurnStartParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const structuredInput = Array.isArray(input.input)
    ? zero3CodexTurnInputs(input.input)
    : [
        {
          type: 'text',
          text: zero3CodexRequiredString(input.text, 'text', 100_000),
          text_elements: []
        }
      ]
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    input: structuredInput
  }
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const model = zero3CodexOptionalString(input.model, 'model', 256)
  const approvalPolicy = zero3CodexApprovalPolicy(input.approvalPolicy)
  if (cwd) params.cwd = cwd
  if (model) params.model = model
  if (approvalPolicy) params.approvalPolicy = approvalPolicy
  return params
}`

const structuredGlobalTypes = String.raw`type Zero3CodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }

type Zero3CodexTurnStartBase = {
  approvalPolicy?: Zero3CodexApprovalPolicy
  cwd?: string
  model?: string
  threadId: string
}

type Zero3CodexTurnStartRequest = Zero3CodexTurnStartBase &
  (
    | { input: Zero3CodexTurnInput[]; text?: never }
    | { input?: never; text: string }
  )`

const primaryChatImports = String.raw`import { attachmentDisplayText, optimisticAttachmentRef } from '@/lib/chat-runtime'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import type { ComposerAttachment } from '@/store/composer'`

const primaryChatHelpers = String.raw`type CodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }

function attachmentContextText(attachment: ComposerAttachment): string {
  const path = attachment.path?.trim() || attachment.detail?.trim() || ''

  if (attachment.kind === 'file') {
    return path ? '[Attached file]\n' + path : attachment.refText?.trim() || attachment.label.trim()
  }
  if (attachment.kind === 'folder') {
    return path ? '[Attached folder]\n' + path : attachment.refText?.trim() || attachment.label.trim()
  }
  if (attachment.kind === 'image') return ''

  return attachmentDisplayText(attachment)?.trim() || attachment.refText?.trim() || attachment.detail?.trim() || attachment.label.trim()
}

function codexTurnInputs(text: string, attachments: ComposerAttachment[]): CodexTurnInput[] {
  const inputs: CodexTurnInput[] = []

  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue
    const imagePath = attachment.path?.trim()
    if (!imagePath) {
      throw new Error('图片附件缺少可供 Codex 读取的本地路径：' + attachment.label)
    }
    inputs.push({ type: 'localImage', path: imagePath })
  }

  const contexts = attachments.map(attachmentContextText).filter(Boolean)
  const combinedText = [...contexts, text].filter(Boolean).join('\n\n').trim()
  if (combinedText) inputs.push({ type: 'text', text: combinedText })

  if (inputs.length === 0) throw new Error('Codex Turn 没有可发送的结构化输入')
  return inputs
}

function userInputProjection(content: unknown): { attachmentRefs: string[]; text: string } {
  if (!Array.isArray(content)) return { attachmentRefs: [], text: '' }

  const text: string[] = []
  const attachmentRefs: string[] = []

  for (const raw of content) {
    const input = record(raw)
    if (input.type === 'text') {
      const value = nonEmptyString(input.text)
      if (value) text.push(value)
      continue
    }

    if (input.type === 'localImage') {
      const imagePath = nonEmptyString(input.path)
      if (!imagePath) continue
      const ref = attachmentDisplayText({
        id: 'codex-history-image:' + imagePath,
        kind: 'image',
        label: imagePath,
        path: imagePath
      })
      if (ref) attachmentRefs.push(ref)
      continue
    }

    if (input.type === 'image') {
      const url = nonEmptyString(input.url)
      if (url) attachmentRefs.push(url)
    }
  }

  return { attachmentRefs, text: text.join('\n') }
}

function userInputText(content: unknown): string {`

const projectedUserInputText = String.raw`function userInputText(content: unknown): string {
  return userInputProjection(content).text
}`

const projectedUserMessage = String.raw`      if (item.type === 'userMessage') {
        const projection = userInputProjection(item.content)
        if (!projection.text && projection.attachmentRefs.length === 0) continue
        messages.push({
          id,
          role: 'user',
          parts: [textPart(projection.text, startedAt)],
          ...(projection.attachmentRefs.length > 0 ? { attachmentRefs: projection.attachmentRefs } : {}),
          ...(startedAt !== undefined ? { timestamp: startedAt } : {})
        })
        continue
      }`

const optimisticUserMessage = String.raw`function optimisticUserMessage(
  text: string,
  attachments: ComposerAttachment[],
  displayText?: string
): ChatMessage {
  const now = Date.now() / 1000
  const attachmentRefs = attachments.map(optimisticAttachmentRef).filter((value): value is string => Boolean(value))
  const bubbleText = displayText?.trim() ?? text
  return {
    id: 'zero3-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    parts: [textPart(bubbleText || (attachmentRefs.length ? '' : attachments.map(item => item.label).join(', ')), now)],
    ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
    timestamp: now
  }
}`

const structuredSubmitPrefix = String.raw`      const text = sanitizeComposerInput(rawText).trim()
      const attachments = (options?.attachments ?? []).filter((attachment): attachment is ComposerAttachment => Boolean(attachment))
      if (!text && attachments.length === 0) return false

      let input: CodexTurnInput[]
      try {
        input = codexTurnInputs(text, attachments)
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 附件无法发送', message: errorMessage(error) })
        return false
      }`

export function applyZero3CodexStructuredInput() {
  patchFile('electron/main.ts', [
    {
      label: 'strict structured Turn input parser',
      from: 'function zero3CodexTurnStartParams(value: unknown) {',
      to: structuredInputParser
    },
    {
      label: 'structured Turn start request mapping',
      from: String.raw`function zero3CodexTurnStartParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const text = zero3CodexRequiredString(input.text, 'text', 100_000)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    input: [{ type: 'text', text, text_elements: [] }]
  }
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const model = zero3CodexOptionalString(input.model, 'model', 256)
  const approvalPolicy = zero3CodexApprovalPolicy(input.approvalPolicy)
  if (cwd) params.cwd = cwd
  if (model) params.model = model
  if (approvalPolicy) params.approvalPolicy = approvalPolicy
  return params
}`,
      to: structuredTurnStart
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'typed structured Turn input request',
      from: String.raw`type Zero3CodexTurnStartRequest = {
  approvalPolicy?: Zero3CodexApprovalPolicy
  cwd?: string
  model?: string
  text: string
  threadId: string
}`,
      to: structuredGlobalTypes
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'attachment presentation imports',
      from: "import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'",
      to: primaryChatImports
    },
    {
      label: 'structured-input projection helpers',
      from: 'function userInputText(content: unknown): string {',
      to: primaryChatHelpers
    },
    {
      label: 'native UserInput text projection',
      from: String.raw`function userInputText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      const input = record(item)
      return input.type === 'text' ? nonEmptyString(input.text) ?? '' : ''
    })
    .filter(Boolean)
    .join('\n')
}`,
      to: projectedUserInputText
    },
    {
      label: 'restored user-message structured attachment projection',
      from: String.raw`      if (item.type === 'userMessage') {
        const text = userInputText(item.content)
        if (!text) continue
        messages.push({
          id,
          role: 'user',
          parts: [textPart(text, startedAt)],
          ...(startedAt !== undefined ? { timestamp: startedAt } : {})
        })
        continue
      }`,
      to: projectedUserMessage
    },
    {
      label: 'optimistic structured attachment bubble',
      from: String.raw`function optimisticUserMessage(text: string): ChatMessage {
  const now = Date.now() / 1000
  return {
    id: 'zero3-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    parts: [textPart(text, now)],
    timestamp: now
  }
}`,
      to: optimisticUserMessage
    },
    {
      label: 'replace blanket attachment rejection with structured-input validation',
      from: String.raw`      const text = sanitizeComposerInput(rawText).trim()
      if (!text) return false

      if ((options?.attachments?.length ?? 0) > 0) {
        notify({
          kind: 'info',
          message: 'R2A 的 Codex 主聊天目前只接管纯文本。附件不会被静默丢弃，请移除附件后发送。'
        })
        return false
      }`,
      to: structuredSubmitPrefix
    },
    {
      label: 'attachment-aware new-thread preview',
      from: '          threadId = await createThread(text)',
      to: "          threadId = await createThread(text || attachments.map(item => item.label).join(', '))"
    },
    {
      label: 'attachment-aware optimistic message',
      from: '        const userMessage = optimisticUserMessage(text)',
      to: '        const userMessage = optimisticUserMessage(text, attachments, options?.displayText)'
    },
    {
      label: 'attachment-aware recent preview',
      from: '        touchSessionActivity(threadId, { preview: text })',
      to: "        touchSessionActivity(threadId, { preview: text || attachments.map(item => item.label).join(', ') })"
    },
    {
      label: 'native structured Turn start input',
      from: String.raw`          threadId,
          text,
          ...(cwd ? { cwd } : {}),`,
      to: String.raw`          threadId,
          input,
          ...(cwd ? { cwd } : {}),`
    }
  ])

  applyZero3CodexStructuredInputHardening()
  console.log('R3C: Hermes composer attachments map to strictly validated Codex text/localImage UserInput without Hermes Runtime staging.')
}
