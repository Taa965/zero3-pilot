import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { hermesDesktopDir, hermesRoot, pins, repoRoot } from './config.mjs'

function exec(file, args) {
  execFileSync(file, args, { cwd: repoRoot, stdio: 'inherit' })
}

if (!fs.isDirectory(hermesRoot)) {
  console.log('Hermes upstream is not initialized; nothing to reset.')
  process.exit(0)
}

exec('git', ['-C', hermesRoot, 'reset', '--hard', pins.hermes])
const stamp = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
if (fs.existsSync(stamp)) fs.rmSync(stamp, { force: true })

console.log(`Hermes upstream reset to ${pins.hermes}.`)
