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
  path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'item-projection.ts')
]
for (const file of generatedFiles) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}

const generatedDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
if (fs.existsSync(generatedDir) && fs.readdirSync(generatedDir).length === 0) {
  fs.rmdirSync(generatedDir)
}

console.log(`Hermes upstream reset to ${pins.hermes}.`)
