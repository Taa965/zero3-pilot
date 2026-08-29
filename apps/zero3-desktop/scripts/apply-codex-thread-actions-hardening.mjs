import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'
import { applyZero3CodexAuthoritativeHistory } from './apply-codex-authoritative-history.mjs'
import { applyZero3CodexTurnMapping } from './apply-codex-turn-mapping.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Codex R3D hardening drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3D thread-action boundary before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const safeWholeThreadFork = String.raw`function zero3CodexThreadForkParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    approvalPolicy: 'on-request',
    sandbox: 'read-only'
  }
}`

const safeArchivedRows = String.raw`        setLocalSessions(
          data
            .filter(value => {
              const thread = settingsRecord(value)
              return thread.parentThreadId == null && thread.ephemeral !== true
            })
            .map(archivedCodexSession)
            .filter((row): row is SessionInfo => Boolean(row))
        )`

export function applyZero3CodexThreadActionsHardening() {
  patchFile('electron/main.ts', [
    {
      label: 'whole-thread fork permission floor',
      from: String.raw`function zero3CodexThreadForkParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256)
  }
  const lastTurnId = zero3CodexOptionalString(input.lastTurnId, 'lastTurnId', 256)
  if (lastTurnId) params.lastTurnId = lastTurnId
  return params
}`,
      to: safeWholeThreadFork
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'whole-thread-only fork renderer surface',
      from: 'type Zero3CodexThreadForkRequest = { lastTurnId?: string; threadId: string }',
      to: 'type Zero3CodexThreadForkRequest = { threadId: string }'
    }
  ])

  patchFile('src/app/settings/sessions-settings.tsx', [
    {
      label: 'remove unused archived projection helper type',
      from: 'type CodexSettingsThread = Record<string, unknown> & { id: string }\n\n',
      to: ''
    },
    {
      label: 'hide Hermes auto-archive policy in Codex mode',
      from: '      <AutoArchiveSetting />',
      to: '      {!window.zero3Codex && <AutoArchiveSetting />}'
    },
    {
      label: 'filter internal archived Codex threads',
      from: '        setLocalSessions(data.map(archivedCodexSession).filter((row): row is SessionInfo => Boolean(row)))',
      to: safeArchivedRows
    }
  ])

  applyZero3CodexTurnMapping()
  applyZero3CodexAuthoritativeHistory()
  console.log('R3D hardening: whole-thread fork is read-only/on-request, lastTurnId stays private outside the dedicated R3E Turn-boundary action, and Hermes auto-archive is hidden in Codex mode.')
  console.log('R3E: authoritative message -> Item -> Turn mapping is applied only after the R3D permission floor.')
  console.log('R3F: authoritative paginated history and historical edit are applied only after the R3E identity boundary.')
}
