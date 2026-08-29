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
        `Zero3 Codex R3B item-projection drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3B projection before updating the pinned Hermes source.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const moreItemPayloads = String.raw`function dynamicOutputText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map(entry => record(entry))
    .filter(entry => entry.type === 'inputText' && typeof entry.text === 'string')
    .map(entry => entry.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function dynamicToolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const namespace = nonEmptyString(item.namespace)
  const tool = nonEmptyString(item.tool) ?? 'tool'
  const status = nonEmptyString(item.status) ?? (phase === 'running' ? 'inProgress' : 'completed')
  const durationMs = typeof item.durationMs === 'number' ? item.durationMs : null
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : []
  const output = dynamicOutputText(contentItems)
  const success = item.success === true ? true : item.success === false ? false : null
  const label = [namespace, tool].filter(Boolean).join(' / ')

  return {
    id: itemId(item) ?? '',
    name: 'dynamic_' + safeToolToken([namespace, tool].filter(Boolean).join('_'), 'tool'),
    args: {
      namespace,
      tool,
      arguments: item.arguments,
      context: label
    },
    ...(phase === 'complete'
      ? {
          result: {
            status,
            ...(success !== null ? { success } : {}),
            ...(output ? { output } : {}),
            ...(contentItems.length > 0 ? { content_items: contentItems } : {}),
            ...(durationMs !== null ? { duration_s: durationMs / 1000 } : {})
          },
          ...(status === 'failed' || success === false ? { error: 'Dynamic tool call failed.' } : {})
        }
      : {})
  }
}

function planPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const text = typeof item.text === 'string' ? item.text.trim() : ''
  return {
    id: itemId(item) ?? '',
    name: 'plan',
    args: {
      context: 'Plan',
      ...(text ? { text } : {})
    },
    ...(phase === 'complete'
      ? {
          result: {
            status: 'completed',
            ...(text ? { summary: text } : {})
          }
        }
      : {})
  }
}

function webSearchPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const query = typeof item.query === 'string' ? item.query.trim() : ''
  const results = Array.isArray(item.results) ? item.results : []
  return {
    id: itemId(item) ?? '',
    name: 'web_search',
    args: {
      query,
      action: item.action
    },
    ...(phase === 'complete'
      ? {
          result: {
            query,
            action: item.action,
            results
          }
        }
      : {})
  }
}

function toolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload | null {`

const expandedToolPayload = String.raw`function toolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload | null {
  if (item.type === 'commandExecution') return commandPayload(item, phase)
  if (item.type === 'fileChange') return fileChangePayload(item, phase)
  if (item.type === 'mcpToolCall') return mcpPayload(item, phase)
  if (item.type === 'dynamicToolCall') return dynamicToolPayload(item, phase)
  if (item.type === 'plan') return planPayload(item, phase)
  if (item.type === 'webSearch') return webSearchPayload(item, phase)

  // Pinned Codex TUI deliberately hides ordinary functionCallOutput rows and
  // only reveals the narrow delegated-tool form after a dedicated parser has
  // validated it. Zero3 preserves that fail-closed presentation policy here:
  // never dump opaque/encrypted function outputs into the chat transcript.
  if (item.type === 'functionCallOutput') return null
  return null
}`

function recordR3BProvenance() {
  const file = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
  provenance.moreItemRenderingPhase = 'R3B-codex-more-items'
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`)
}

export function applyZero3CodexMoreItems() {
  patchFile('src/app/zero3-codex/item-projection.ts', [
    {
      label: 'R3B native item payload helpers',
      from: "function toolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload | null {",
      to: moreItemPayloads
    },
    {
      label: 'R3B native item payload dispatch',
      from:
        "function toolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload | null {\n" +
        "  if (item.type === 'commandExecution') return commandPayload(item, phase)\n" +
        "  if (item.type === 'fileChange') return fileChangePayload(item, phase)\n" +
        "  if (item.type === 'mcpToolCall') return mcpPayload(item, phase)\n" +
        "  return null\n" +
        "}",
      to: expandedToolPayload
    }
  ])
  recordR3BProvenance()
  console.log('R3B: Codex dynamicToolCall, plan and webSearch Items use the Hermes-derived presentation layer; opaque functionCallOutput remains hidden.')
}
