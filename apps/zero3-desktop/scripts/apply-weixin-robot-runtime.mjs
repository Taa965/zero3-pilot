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
    const candidates = replacement.fromAny ?? [replacement.from]
    const from = candidates.find(candidate => candidate && source.includes(candidate))
    if (!from) {
      throw new Error(`Robot desktop bridge drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(from, replacement.to)
  }
  write(file, source)
}

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Robots', {
  weixinStatus: () => ipcRenderer.invoke('zero3:robots:weixin-status'),
  launchWeixinBinding: () => ipcRenderer.invoke('zero3:robots:weixin-bind'),
  disconnectWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-disconnect'),
  startWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-start'),
  stopWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-stop'),
  qqStatus: () => ipcRenderer.invoke('zero3:robots:qq-status'),
  launchQqBinding: () => ipcRenderer.invoke('zero3:robots:qq-bind'),
  disconnectQq: () => ipcRenderer.invoke('zero3:robots:qq-disconnect'),
  startQq: () => ipcRenderer.invoke('zero3:robots:qq-start'),
  stopQq: () => ipcRenderer.invoke('zero3:robots:qq-stop'),
  settings: () => ipcRenderer.invoke('zero3:robots:settings'),
  setSettings: request => ipcRenderer.invoke('zero3:robots:settings-set', request)
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
      label: 'Robot v2 IPC registration boundary',
      marker: 'listZero3Profiles: zero3ListApiProfiles',
      fromAny: [
        "const zero3CodexAppServer = createZero3CodexAppServer()\nconst disposeZero3WeixinRobotIpc = registerWeixinRobotDesktopIpc()\napp.on('before-quit', () => disposeZero3WeixinRobotIpc())\n",
        'const zero3CodexAppServer = createZero3CodexAppServer()\n'
      ],
      to: `const zero3CodexAppServer = createZero3CodexAppServer()
const disposeZero3WeixinRobotIpc = registerWeixinRobotDesktopIpc({
  listZero3Profiles: zero3ListApiProfiles,
  runZero3: async (profileId, request) => {
    const state = await zero3ApiProfileRead()
    const profile = state.profiles[profileId]
    if (!profile) throw new Error('Zero3 API Profile 不存在')
    return zero3ApiRobotTurn(profile, request)
  },
  runCodex: request => zero3RunCodexCliTurn(request),
  runClaude: request => zero3RunClaudeTurn(request),
  defaultCwd: () => process.env.ZERO3_CODEX_CWD?.trim() || app.getPath('home')
})
app.on('before-quit', () => disposeZero3WeixinRobotIpc())
`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'Robot v2 explicit preload API',
      marker: "startWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-start')",
      fromAny: [
        String.raw`contextBridge.exposeInMainWorld('zero3Robots', {
  weixinStatus: () => ipcRenderer.invoke('zero3:robots:weixin-status'),
  launchWeixinBinding: () => ipcRenderer.invoke('zero3:robots:weixin-bind'),
  disconnectWeixin: () => ipcRenderer.invoke('zero3:robots:weixin-disconnect')
})

contextBridge.exposeInMainWorld('hermesDesktop', {`,
        "contextBridge.exposeInMainWorld('hermesDesktop', {"
      ],
      to: preloadBridge
    }
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  applyZero3WeixinRobotRuntime()
}
