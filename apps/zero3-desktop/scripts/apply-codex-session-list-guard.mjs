import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

export function applyZero3CodexSessionListGuard() {
  const file = path.join(
    hermesDesktopDir,
    'src',
    'app',
    'session',
    'hooks',
    'use-session-list-actions.ts'
  )
  let source = fs.readFileSync(file, 'utf8')

  const from = `      $sidebarFiltersActive.subscribe(active => {
        if (active) {`
  const to = `      $sidebarFiltersActive.subscribe(active => {
        // R2: recents are Codex Thread rows. The legacy Hermes list hook stays
        // mounted for messaging/cron compatibility, but sidebar filter depth
        // changes must never replace Codex recents with Hermes sessions.
        if (window.zero3Codex) {
          return
        }

        if (active) {`

  if (!source.includes(to)) {
    if (!source.includes(from)) {
      throw new Error(
        'Zero3 Codex session-list guard drift: pinned Hermes sidebar filter refresh changed upstream.'
      )
    }
    source = source.replace(from, to)
  }

  fs.writeFileSync(file, source)
}
