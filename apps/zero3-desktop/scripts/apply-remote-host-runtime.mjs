import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'host-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'remote-host')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Remote Host overlay drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes/Codex desktop boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copyRuntimeSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  const files = [
    'remote-types.ts',
    'remote-config.ts',
    'remote-client.ts',
    'remote-evidence.ts',
    'remote-task-runner.ts',
    'remote-node.ts',
    'index.ts'
  ]
  for (const file of files) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Remote Host source template missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

export function applyZero3RemoteHostRuntime() {
  copyRuntimeSources()

  patchFile('electron/main.ts', [
    {
      label: 'end of Electron import block',
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to:
        "import { Zero3RemoteNode } from './zero3/remote-host/index'\n\n" +
        "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Electron ready boundary after Codex transport registration',
      from: "app.whenReady().then(() => {",
      to:
        "const zero3RemoteNode = new Zero3RemoteNode({\n" +
        "  startThread: params => zero3CodexAppServer.request('thread/start', params),\n" +
        "  startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs),\n" +
        "  readThread: params => zero3CodexAppServer.request('thread/read', params)\n" +
        "})\n" +
        "app.on('before-quit', () => zero3RemoteNode.stop())\n\n" +
        "app.whenReady().then(() => {\n" +
        "  zero3RemoteNode.start()"
    }
  ])
}
