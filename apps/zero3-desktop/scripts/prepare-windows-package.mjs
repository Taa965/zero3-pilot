import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

if (process.platform !== 'win32') {
  throw new Error('prepare-windows-package.mjs must run on Windows.')
}

const stagedCodex = path.join(hermesDesktopDir, 'build', 'zero3-codex', 'codex.exe')
if (!fs.existsSync(stagedCodex) || !fs.statSync(stagedCodex).isFile() || fs.statSync(stagedCodex).size === 0) {
  throw new Error(`Pinned Codex release binary is not staged for packaging: ${stagedCodex}`)
}

const packagePath = path.join(hermesDesktopDir, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
packageJson.version = '0.1.0-alpha'
packageJson.scripts = packageJson.scripts ?? {}
packageJson.scripts['dist:win'] = 'npm run build && npm run builder -- --win nsis --publish never'
packageJson.build = packageJson.build ?? {}
packageJson.build.win = packageJson.build.win ?? {}
const extraResources = Array.isArray(packageJson.build.win.extraResources)
  ? packageJson.build.win.extraResources.filter(item => item?.to !== 'zero3-codex/codex.exe')
  : []
extraResources.push({
  from: 'build/zero3-codex/codex.exe',
  to: 'zero3-codex/codex.exe'
})
packageJson.build.win.extraResources = extraResources
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

const mainPath = path.join(hermesDesktopDir, 'electron', 'main.ts')
let main = fs.readFileSync(mainPath, 'utf8')
const oldResolver = `    const executable = this.launchEnv.ZERO3_CODEX_BIN?.trim()\n    if (!executable) {\n      throw new Error(\n        'ZERO3_CODEX_BIN is not configured. Zero3 must launch the pinned open-source Codex build, not an implicit external Agent.'\n      )\n    }`
const newResolver = `    const configuredExecutable = this.launchEnv.ZERO3_CODEX_BIN?.trim()\n    const bundledExecutable =\n      app.isPackaged && process.platform === 'win32'\n        ? path.join(process.resourcesPath, 'zero3-codex', 'codex.exe')\n        : ''\n    const executable = configuredExecutable || bundledExecutable\n    if (!executable) {\n      throw new Error(\n        'ZERO3_CODEX_BIN is not configured. Zero3 must launch the pinned open-source Codex build, not an implicit external Agent.'\n      )\n    }\n    if (app.isPackaged) {\n      if (!bundledExecutable || executable !== bundledExecutable) {\n        throw new Error('Packaged Zero3 Pilot must launch its bundled pinned Codex binary.')\n      }\n      if (!fs.existsSync(executable)) {\n        throw new Error('Bundled pinned Codex binary is missing from Zero3 Pilot resources.')\n      }\n    }`
if (!main.includes(newResolver)) {
  if (!main.includes(oldResolver)) {
    throw new Error('Zero3 packaged Codex runtime drift: executable resolver changed upstream.')
  }
  main = main.replace(oldResolver, newResolver)
  fs.writeFileSync(mainPath, main)
}

console.log('Zero3 Windows package prepared: v0.1.0-alpha, NSIS publish disabled, pinned Codex bundled in resources.')
