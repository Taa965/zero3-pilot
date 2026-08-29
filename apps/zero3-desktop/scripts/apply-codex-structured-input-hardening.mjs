import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Codex R3C structured-input hardening drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3C structured-input boundary before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const exclusiveTurnInput = String.raw`  const hasStructuredInput = Object.prototype.hasOwnProperty.call(input, 'input')
  const hasLegacyText = Object.prototype.hasOwnProperty.call(input, 'text')
  if (hasStructuredInput === hasLegacyText) {
    throw new Error('turn/start must contain exactly one of input or text')
  }
  const structuredInput = hasStructuredInput
    ? zero3CodexTurnInputs(input.input)
    : [
        {
          type: 'text',
          text: zero3CodexRequiredString(input.text, 'text', 100_000),
          text_elements: []
        }
      ]`

const terminalImport = String.raw`import { terminalContextBlocksFromDraft, type ComposerAttachment } from '@/store/composer'`

const terminalAwareContext = String.raw`  const contexts = attachments.map(attachmentContextText).filter(Boolean)
  const terminalContexts = terminalContextBlocksFromDraft(text)
  const combinedText = [...contexts, ...terminalContexts, text].filter(Boolean).join('\n\n').trim()`

export function applyZero3CodexStructuredInputHardening() {
  patchFile('electron/main.ts', [
    {
      label: 'exclusive legacy-text versus structured-input request shape',
      from: String.raw`  const structuredInput = Array.isArray(input.input)
    ? zero3CodexTurnInputs(input.input)
    : [
        {
          type: 'text',
          text: zero3CodexRequiredString(input.text, 'text', 100_000),
          text_elements: []
        }
      ]`,
      to: exclusiveTurnInput
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'terminal-context helper import',
      from: "import type { ComposerAttachment } from '@/store/composer'",
      to: terminalImport
    },
    {
      label: 'Hermes terminal selection expansion into Codex text UserInput',
      from: String.raw`  const contexts = attachments.map(attachmentContextText).filter(Boolean)
  const combinedText = [...contexts, text].filter(Boolean).join('\n\n').trim()`,
      to: terminalAwareContext
    }
  ])

  console.log('R3C hardening: turn/start enforces one input shape; saved terminal selections expand into validated Codex text without Hermes Runtime execution.')
}
