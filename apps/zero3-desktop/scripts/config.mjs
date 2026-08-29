import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const repoRoot = path.resolve(here, '../../..')
export const upstreamRoot = path.join(repoRoot, 'upstream')
export const hermesRoot = path.join(upstreamRoot, 'hermes-agent')
export const hermesDesktopDir = path.join(hermesRoot, 'apps', 'desktop')
export const codexRoot = path.join(upstreamRoot, 'codex')
export const deepseekRoot = path.join(upstreamRoot, 'deepseek-harness')

export const pins = Object.freeze({
  codex: '94311d447587411789533c47601fd8bc9d81eb48',
  hermes: 'f7c79efbac19ae18e8dee7c79a4e4c0935299b5f',
  deepseek: 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
})

export function resolveHermesHome() {
  if (process.env.ZERO3_HERMES_HOME) return path.resolve(process.env.ZERO3_HERMES_HOME)
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Zero3Pilot', 'hermes')
  }
  return path.join(os.homedir(), '.local', 'share', 'zero3-pilot', 'hermes')
}

export function resolveCodexHome() {
  if (process.env.ZERO3_CODEX_HOME) return path.resolve(process.env.ZERO3_CODEX_HOME)
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Zero3Pilot', 'codex')
  }
  return path.join(os.homedir(), '.local', 'share', 'zero3-pilot', 'codex')
}

export function pinnedCodexBinary() {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  return path.join(codexRoot, 'codex-rs', 'target', 'debug', exe)
}

export function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base
}
