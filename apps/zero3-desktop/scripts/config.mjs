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
  if (process.platform === 'win32') return path.join(resolveZero3DataRoot(), 'hermes')
  if (process.env.ZERO3_HERMES_HOME) return path.resolve(process.env.ZERO3_HERMES_HOME)
  return path.join(os.homedir(), '.local', 'share', 'zero3-pilot', 'hermes')
}

export function resolveCodexHome() {
  if (process.platform === 'win32') return path.join(resolveZero3DataRoot(), 'codex')
  if (process.env.ZERO3_CODEX_HOME) return path.resolve(process.env.ZERO3_CODEX_HOME)
  return path.join(os.homedir(), '.local', 'share', 'zero3-pilot', 'codex')
}

export function resolveZero3DataRoot() {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'Documents', 'Zero3 Pilot')
    : path.join(os.homedir(), '.local', 'share', 'zero3-pilot')
}

export function pinnedCodexBinary(profile = 'debug') {
  if (profile !== 'debug' && profile !== 'release') {
    throw new Error(`Unsupported Codex build profile: ${profile}`)
  }
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  return path.join(codexRoot, 'codex-rs', 'target', profile, exe)
}

export function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base
}

// Runtimes are copied into sibling directories under electron/zero3/, and a
// cross-runtime import survives the copy whenever the directory keeps its name
// (agent-routing imports ../executor-runtime/... unchanged). Only the workspace
// runtime is renamed on the way in -- workspace-runtime becomes workspace -- so
// its specifier has to be rewritten, or a shared helper like the atomic file
// writer cannot be imported from anywhere else without duplicating the file.
// Rewriting here keeps the source tree honest: it says where the file really is.
const OVERLAY_DIRECTORY_RENAMES = [['workspace-runtime', 'workspace']]

export function overlayRuntimeSource(text) {
  let source = text
  for (const [from, to] of OVERLAY_DIRECTORY_RENAMES) {
    // The leading `../` run is preserved so a nested runtime (executor-runtime
    // /handoff, say) rewrites to the same depth it asked for.
    source = source.replace(new RegExp(`(from '(?:\\.\\./)+)${from}/`, 'gu'), `$1${to}/`)
  }
  return source
}
