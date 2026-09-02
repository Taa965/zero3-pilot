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
        `Zero3 Codex session persistence drift in ${relativePath}: could not find ${replacement.label}.`
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3CodexSessionListGuard() {
  patchFile('src/app/session/hooks/use-session-list-actions.ts', [
    {
      label: 'legacy Hermes sidebar filter refresh',
      from: `      $sidebarFiltersActive.subscribe(active => {
        if (active) {`,
      to: `      $sidebarFiltersActive.subscribe(active => {
        // R2: recents are Codex Thread rows. The legacy Hermes list hook stays
        // mounted for messaging/cron compatibility, but sidebar filter depth
        // changes must never replace Codex recents with Hermes sessions.
        if (window.zero3Codex) {
          return
        }

        if (active) {`
    }
  ])

  patchFile('electron/main.ts', [
    {
      label: 'Zero3 app-server session-source identity',
      from: `    const child = spawn(executable, ['app-server', '--stdio'], {`,
      to: `    // Codex app-server defaults --session-source to vscode. Zero3 must
    // claim its own durable AppServer/Mcp source explicitly so thread/list can
    // address Zero3 conversations without colliding with VS Code history.
    const child = spawn(executable, ['app-server', '--stdio', '--session-source', 'app-server'], {`
    },
    {
      label: 'Codex thread/list source filter',
      from: `function zero3CodexThreadListParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {}`,
      to: `function zero3CodexThreadListParams(value: unknown) {
  const input = zero3CodexRecord(value)
  // Pinned Codex defaults thread/list to interactive CLI/VS Code sources when
  // sourceKinds is omitted. Zero3 explicitly launches app-server with
  // --session-source app-server (CoreSessionSource::Mcp), so this filter is the
  // stable Zero3-owned conversation namespace across renderer/app restarts.
  const params: Record<string, unknown> = { sourceKinds: ['appServer'] }`
    }
  ])
}
