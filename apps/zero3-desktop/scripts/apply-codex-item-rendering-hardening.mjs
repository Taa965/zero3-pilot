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
        `Zero3 Codex item-rendering hardening drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3A projection before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3CodexItemRenderingHardening() {
  patchFile('src/app/zero3-codex/item-projection.ts', [
    {
      label: 'structured file-change kind type',
      from:
        "type NormalizedFileChange = {\n" +
        "  path: string\n" +
        "  kind: string\n" +
        "  diff: string\n" +
        "}",
      to:
        "type NormalizedFileChange = {\n" +
        "  path: string\n" +
        "  kind: string\n" +
        "  diff: string\n" +
        "  movePath?: string\n" +
        "}"
    },
    {
      label: 'structured file-change kind normalization',
      from:
        "  return value\n" +
        "    .map(entry => record(entry))\n" +
        "    .map(entry => ({\n" +
        "      path: nonEmptyString(entry.path) ?? '',\n" +
        "      kind: nonEmptyString(entry.kind) ?? '',\n" +
        "      diff: typeof entry.diff === 'string' ? entry.diff : ''\n" +
        "    }))\n" +
        "    .filter(change => change.path || change.diff)",
      to:
        "  return value\n" +
        "    .map(entry => record(entry))\n" +
        "    .map(entry => {\n" +
        "      const kind = record(entry.kind)\n" +
        "      return {\n" +
        "        path: nonEmptyString(entry.path) ?? '',\n" +
        "        kind: nonEmptyString(kind.type) ?? '',\n" +
        "        diff: typeof entry.diff === 'string' ? entry.diff : '',\n" +
        "        ...(typeof kind.move_path === 'string' && kind.move_path.trim()\n" +
        "          ? { movePath: kind.move_path.trim() }\n" +
        "          : {})\n" +
        "      }\n" +
        "    })\n" +
        "    .filter(change => change.path || change.diff)"
    },
    {
      label: 'MCP error message normalization',
      from:
        "function errorText(value: unknown): string {\n" +
        "  if (typeof value === 'string') return value\n" +
        "  if (!value) return ''\n" +
        "  try {\n" +
        "    return JSON.stringify(value)\n" +
        "  } catch {\n" +
        "    return String(value)\n" +
        "  }\n" +
        "}",
      to:
        "function errorText(value: unknown): string {\n" +
        "  if (typeof value === 'string') return value\n" +
        "  if (!value) return ''\n" +
        "  const message = nonEmptyString(record(value).message)\n" +
        "  if (message) return message\n" +
        "  try {\n" +
        "    return JSON.stringify(value)\n" +
        "  } catch {\n" +
        "    return String(value)\n" +
        "  }\n" +
        "}"
    },
    {
      label: 'command declined terminal state',
      from: "          ...(status === 'failed' ? { error: true } : {})",
      to:
        "          ...(status === 'failed' || status === 'declined'\n" +
        "            ? { error: status === 'declined' ? 'Command execution declined.' : true }\n" +
        "            : {})"
    },
    {
      label: 'file change declined state',
      from: "          ...(status === 'failed' ? { error: true } : {})",
      to:
        "          ...(status === 'failed' || status === 'declined'\n" +
        "            ? { error: status === 'declined' ? 'File change declined.' : true }\n" +
        "            : {})"
    },
    {
      label: 'summary stream reset helper',
      from: 'export function projectCodexCommandOutputDelta(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {',
      to:
        "export function projectCodexReasoningSummaryDelta(\n" +
        "  messages: ChatMessage[],\n" +
        "  id: string,\n" +
        "  delta: string,\n" +
        "  occurredAt: number,\n" +
        "  resetToSummary: boolean\n" +
        "): ChatMessage[] {\n" +
        "  if (!delta) return messages\n" +
        "  return resetToSummary\n" +
        "    ? upsertReasoningMessage(messages, id, delta, 'running', occurredAt)\n" +
        "    : projectCodexReasoningDelta(messages, id, delta, occurredAt)\n" +
        "}\n\n" +
        "export function projectCodexCommandOutputDelta(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {"
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'summary-specific projection import',
      from: "  projectCodexReasoningDelta\n} from './item-projection'",
      to: "  projectCodexReasoningDelta,\n  projectCodexReasoningSummaryDelta\n} from './item-projection'"
    },
    {
      label: 'summary stream takes over raw reasoning',
      from:
        "        if (itemId && delta) {\n" +
        "          reasoningSummaryItemsRef.current.add(itemId)\n" +
        "          updateSessionState(\n" +
        "            threadId,\n" +
        "            state => ({\n" +
        "              ...state,\n" +
        "              messages: projectCodexReasoningDelta(state.messages, itemId, delta, Date.now() / 1000)\n" +
        "            }),\n" +
        "            threadId\n" +
        "          )\n" +
        "        }",
      to:
        "        if (itemId && delta) {\n" +
        "          const firstSummaryDelta = !reasoningSummaryItemsRef.current.has(itemId)\n" +
        "          reasoningSummaryItemsRef.current.add(itemId)\n" +
        "          updateSessionState(\n" +
        "            threadId,\n" +
        "            state => ({\n" +
        "              ...state,\n" +
        "              messages: projectCodexReasoningSummaryDelta(\n" +
        "                state.messages,\n" +
        "                itemId,\n" +
        "                delta,\n" +
        "                Date.now() / 1000,\n" +
        "                firstSummaryDelta\n" +
        "              )\n" +
        "            }),\n" +
        "            threadId\n" +
        "          )\n" +
        "        }"
    }
  ])
}
