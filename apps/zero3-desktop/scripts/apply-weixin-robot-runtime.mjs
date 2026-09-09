import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'

const runtimeSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'robot-runtime', 'weixin-robot-runtime.ts')
const runtimeTarget = path.join(hermesDesktopDir, 'electron', 'zero3', 'robot-runtime', 'weixin-robot-runtime.ts')

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
    if (source.includes(replacement.marker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Weixin robot desktop bridge drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Robots', {
  weixinStatus: () => ipcRenderer.invoke('zero3:robots:weixin-status'),
  launchWeixinBinding: () => ipcRenderer.invoke('zero3:robots:weixin-bind'),
  disconnectWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-disconnect')
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

export function applyZero3WeixinRobotRuntime() {
  if (!fs.existsSync(runtimeSource)) {
    throw new Error(`Weixin robot runtime source missing: ${runtimeSource}`)
  }
  write(runtimeTarget, overlayRuntimeSource(read(runtimeSource)))

  patchFile('electron/main.ts', [
    {
      label: 'Weixin robot runtime import boundary',
      marker: "registerWeixinRobotDesktopIpc } from './zero3/robot-runtime/weixin-robot-runtime'",
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { registerWeixinRobotDesktopIpc } from './zero3/robot-runtime/weixin-robot-runtime'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Weixin robot IPC registration boundary',
      marker: 'disposeZero3WeixinRobotIpc',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()\n',
      to: "const zero3CodexAppServer = createZero3CodexAppServer()\nconst disposeZero3WeixinRobotIpc = registerWeixinRobotDesktopIpc()\napp.on('before-quit', () => disposeZero3WeixinRobotIpc())\n"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'Weixin robot explicit preload API',
      marker: "exposeInMainWorld('zero3Robots'",
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: preloadBridge
    }
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  applyZero3WeixinRobotRuntime()
}
