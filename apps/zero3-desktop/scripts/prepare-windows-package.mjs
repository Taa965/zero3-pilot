import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

if (process.platform !== 'win32') {
  throw new Error('prepare-windows-package.mjs must run on Windows.')
}

for (const required of [
  path.join(hermesDesktopDir, 'build', 'zero3-codex', 'codex.exe'),
  path.join(hermesDesktopDir, 'build', 'zero3-legal', 'LICENSE-Zero3-Pilot.txt'),
  path.join(hermesDesktopDir, 'build', 'zero3-legal', 'NOTICE-Zero3-Pilot.txt'),
  path.join(hermesDesktopDir, 'build', 'zero3-legal', 'LICENSE-OpenAI-Codex.txt'),
  path.join(hermesDesktopDir, 'build', 'zero3-legal', 'NOTICE-OpenAI-Codex.txt'),
  path.join(hermesDesktopDir, 'build', 'zero3-legal', 'LICENSE-Hermes-Agent.txt')
]) {
  if (!fs.existsSync(required) || !fs.statSync(required).isFile() || fs.statSync(required).size === 0) {
    throw new Error(`Required Windows release resource is not staged: ${required}`)
  }
}

const packagePath = path.join(hermesDesktopDir, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
packageJson.version = '0.1.0-alpha'
packageJson.scripts = packageJson.scripts ?? {}
packageJson.scripts['dist:win'] = 'npm run build && npm run builder -- --win nsis --publish never'
packageJson.build = packageJson.build ?? {}
packageJson.build.win = packageJson.build.win ?? {}
const managedTargets = new Set(['zero3-codex/codex.exe', 'legal'])
const extraResources = Array.isArray(packageJson.build.win.extraResources)
  ? packageJson.build.win.extraResources.filter(item => !managedTargets.has(item?.to))
  : []
extraResources.push(
  {
    from: 'build/zero3-codex/codex.exe',
    to: 'zero3-codex/codex.exe'
  },
  {
    from: 'build/zero3-legal',
    to: 'legal'
  }
)
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

console.log('Zero3 Windows package prepared: v0.1.0-alpha, NSIS publish disabled, pinned Codex and legal notices bundled.')
