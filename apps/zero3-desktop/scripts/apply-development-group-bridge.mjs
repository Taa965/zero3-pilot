import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Development Group desktop bridge drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  fs.writeFileSync(file, source)
}

function copyAuthority(sourceRelative, targetRelative) {
  const source = path.join(repoRoot, ...sourceRelative.split('/'))
  const target = path.join(hermesDesktopDir, ...targetRelative.split('/'))
  if (!fs.existsSync(source)) throw new Error(`Development Group authority source missing: ${sourceRelative}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

export function applyDevelopmentGroupBridge() {
  copyAuthority(
    'apps/zero3-desktop/group-runtime/desktop/desktop-port.ts',
    'electron/zero3/development-group/desktop-port.ts'
  )
  copyAuthority(
    'apps/zero3-desktop/group-runtime/desktop/desktop-ipc.ts',
    'electron/zero3/development-group/desktop-ipc.ts'
  )

  patchFile('electron/preload.ts', [
    {
      label: 'Development Group explicit preload API',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: `contextBridge.exposeInMainWorld('zero3DevelopmentGroup', {
  listGroups: () => ipcRenderer.invoke('zero3:development-group:list'),
  getGroup: groupId => ipcRenderer.invoke('zero3:development-group:get', groupId),
  createGroup: (request, proposal) => ipcRenderer.invoke('zero3:development-group:create', request, proposal),
  startWave: (groupId, waveId) => ipcRenderer.invoke('zero3:development-group:start-wave', groupId, waveId),
  integrateDelivery: (groupId, sessionId) => ipcRenderer.invoke('zero3:development-group:integrate-delivery', groupId, sessionId),
  runVerification: groupId => ipcRenderer.invoke('zero3:development-group:run-verification', groupId),
  getCompletionProof: groupId => ipcRenderer.invoke('zero3:development-group:completion-proof', groupId),
  completeGroup: groupId => ipcRenderer.invoke('zero3:development-group:complete', groupId)
})

contextBridge.exposeInMainWorld('hermesDesktop', {`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Development Group renderer bridge types',
      from: `  interface Window {
    hermesDesktop: {`,
      to: `  interface Window {
    zero3DevelopmentGroup: {
      listGroups: () => Promise<unknown>
      getGroup: (groupId: string) => Promise<unknown>
      createGroup: (request: Record<string, unknown>, proposal: Record<string, unknown>) => Promise<unknown>
      startWave: (groupId: string, waveId: string) => Promise<unknown>
      integrateDelivery: (groupId: string, sessionId: string) => Promise<unknown>
      runVerification: (groupId: string) => Promise<unknown>
      getCompletionProof: (groupId: string) => Promise<unknown>
      completeGroup: (groupId: string) => Promise<unknown>
    }
    hermesDesktop: {`
    }
  ])
}
