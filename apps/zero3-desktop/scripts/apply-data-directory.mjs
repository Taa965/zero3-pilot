import fs from 'node:fs'
import path from 'node:path'
import { hermesDesktopDir } from './config.mjs'

// Apply before any Electron userData/agent stores are constructed. AppData can
// be virtualized by the launching MSIX app (e.g. Claude); Documents is shared.
export const fixedDirectorySetup = `// Zero3 fixed Windows data directory: independent of the launching app.
if (process.platform === 'win32') {
  const zero3DataRoot = path.join(os.homedir(), 'Documents', 'Zero3 Pilot')
  process.env.HERMES_DESKTOP_USER_DATA_DIR = zero3DataRoot
  process.env.ZERO3_HERMES_HOME = path.join(zero3DataRoot, 'hermes')
  process.env.HERMES_HOME = process.env.ZERO3_HERMES_HOME
  process.env.ZERO3_CODEX_HOME = path.join(zero3DataRoot, 'codex')
  process.env.CODEX_HOME = process.env.ZERO3_CODEX_HOME
}

`

export function applyZero3DataDirectory() {
  const file = path.join(hermesDesktopDir, 'electron', 'main.ts')
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(fixedDirectorySetup)) return
  const anchor = 'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR'
  if (!source.includes(anchor)) throw new Error('Zero3 data directory overlay drift: missing userData setup')
  fs.writeFileSync(file, source.replace(anchor, fixedDirectorySetup + anchor))
}
