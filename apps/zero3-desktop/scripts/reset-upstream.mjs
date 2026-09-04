import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { resetCodexOverlay } from '../../../scripts/codex-overlay.mjs'
import { codexRoot, hermesDesktopDir, hermesRoot, pins, repoRoot } from './config.mjs'

function exec(file, args) {
  execFileSync(file, args, { cwd: repoRoot, stdio: 'inherit' })
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

if (isDirectory(codexRoot)) {
  resetCodexOverlay({ repoRoot, codexRoot, expectedPins: pins })
  console.log(`Codex overlay reset to ${pins.codex}.`)
} else {
  console.log('Codex upstream is not initialized; no Codex overlay to reset.')
}

if (!isDirectory(hermesRoot)) {
  console.log('Hermes upstream is not initialized; nothing else to reset.')
  process.exit(0)
}

exec('git', ['-C', hermesRoot, 'reset', '--hard', pins.hermes])

const generatedFiles = [
  path.join(hermesDesktopDir, 'public', 'zero3-upstream.json'),
  path.join(hermesDesktopDir, 'public', 'zero3-pilot.png'),
  path.join(hermesDesktopDir, 'src', 'app', 'settings', 'zero3-control-settings.tsx'),
  path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'primary-chat.ts'),
  path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'prompt-store.ts'),
  path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'prompt-overlay.tsx'),
  path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'item-projection.ts'),
  path.join(hermesDesktopDir, 'src', 'app', 'chat', 'sidebar', 'zero3-gpt-web-section.tsx'),
  path.join(hermesDesktopDir, 'src', 'app', 'chat', 'sidebar', 'gpt-web-handoff-actions.tsx'),
  path.join(hermesDesktopDir, 'src', 'app', 'chat', 'sidebar', 'gemini-session-section.tsx')
]
for (const file of generatedFiles) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}

// Every Zero3 Electron-main provider/agent runtime is generated from reviewed
// templates during prepare. Removing the whole generated root makes reset
// deterministic across GPT/Gemini/Antigravity/Development-Group overlays and
// prevents a stale untracked module from making the next prepare look healthy.
const zero3ElectronRoot = path.join(hermesDesktopDir, 'electron', 'zero3')
if (fs.existsSync(zero3ElectronRoot)) fs.rmSync(zero3ElectronRoot, { recursive: true, force: true })

const zero3CodexDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
if (fs.existsSync(zero3CodexDir)) fs.rmSync(zero3CodexDir, { recursive: true, force: true })

const zero3UiDir = path.join(hermesDesktopDir, 'src', 'zero3-ui')
if (fs.existsSync(zero3UiDir)) fs.rmSync(zero3UiDir, { recursive: true, force: true })

console.log(`Hermes upstream reset to ${pins.hermes}.`)
