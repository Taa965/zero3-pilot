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
      label: 'Zero3 Codex event broadcaster',
      from: "function broadcastZero3CodexEvent(event: Zero3CodexEvent) {\n  for (const window of BrowserWindow.getAllWindows()) {",
      to:
        "const zero3CodexLocalEventListeners = new Set<(event: Zero3CodexEvent) => void>()\n\n" +
        "function broadcastZero3CodexEvent(event: Zero3CodexEvent) {\n" +
        "  for (const listener of zero3CodexLocalEventListeners) {\n" +
        "    try { listener(event) } catch { /* local observers must not break Codex transport */ }\n" +
        "  }\n" +
        "  for (const window of BrowserWindow.getAllWindows()) {"
    },
    {
      label: 'Zero3CodexAppServer server-response method',
      from: "  async respondToServerRequest(value: unknown) {",
      to:
        "  onEvent(listener: (event: Zero3CodexEvent) => void) {\n" +
        "    zero3CodexLocalEventListeners.add(listener)\n" +
        "    return () => zero3CodexLocalEventListeners.delete(listener)\n" +
        "  }\n\n" +
        "  async respondToServerRequest(value: unknown) {"
    },
    {
      label: 'Zero3 Codex singleton',
      from: "const zero3CodexAppServer = new Zero3CodexAppServer()",
      to:
        "const zero3CodexAppServer = new Zero3CodexAppServer()\n" +
        "const zero3RemoteNode = new Zero3RemoteNode(zero3CodexAppServer)\n" +
        "app.once('ready', () => zero3RemoteNode.start())"
    },
    {
      label: 'typed Codex before-quit hook',
      from: "app.on('before-quit', () => zero3CodexAppServer.stop())",
      to:
        "app.on('before-quit', () => {\n" +
        "  zero3RemoteNode.stop()\n" +
        "  zero3CodexAppServer.stop()\n" +
        "})"
    }
  ])
}
