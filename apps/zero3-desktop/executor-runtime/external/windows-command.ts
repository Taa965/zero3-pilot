import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Windows spawn without a shell does not apply PATHEXT, so a bare command name
// like "claude" never finds the claude.cmd that npm puts on PATH: the spawn
// fails with ENOENT and the CLI reads as "not installed". Spawning that .cmd
// directly is not a fix either -- Node refuses .cmd and .bat without a shell
// and raises EINVAL.
//
// Turning on `shell: true` would resolve the lookup, but every argument would
// then travel through cmd.exe, where a prompt containing & or | stops being one
// argument. npm's shim is a small batch file whose last line performs the real
// call, so reading that line yields something spawnable with no shell at all.
//
// Two shim shapes exist and both matter here:
//   claude.cmd  ->  "%dp0%\...\claude.exe"        %*
//   codex.cmd   ->  "%_prog%" "%dp0%\...\codex.js" %*
// The second forwards through node, so resolution has to be able to answer
// with an interpreter plus a script rather than a single path.

export type ResolvedCommand = {
  command: string
  /** Arguments the shim supplies before the caller's own, e.g. the script path. */
  args: string[]
}

function findOnPath(directories: string[], name: string): string | null {
  for (const directory of directories) {
    const candidate = path.join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Directories a Windows CLI installer writes into, searched after PATH.
 *
 * A process inherits its parent's environment, so a desktop app started from a
 * long-lived parent keeps that parent's PATH forever. A CLI installed after
 * that parent started is then invisible to the app no matter that every new
 * shell finds it -- which reads as "未安装" for a CLI sitting right there on
 * disk. These locations are stable per installer, so consulting them makes
 * detection independent of how the app happened to be launched.
 */
function installerDirectories(): string[] {
  const home = process.env.USERPROFILE
  const roaming = process.env.APPDATA
  const local = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  return [
    roaming ? path.join(roaming, 'npm') : '',
    local ? path.join(local, 'npm') : '',
    local ? path.join(local, 'Microsoft', 'WinGet', 'Links') : '',
    home ? path.join(home, '.local', 'bin') : '',
    programFiles ? path.join(programFiles, 'nodejs') : ''
  ].filter(Boolean)
}

/**
 * Say what resolution actually produced, for an error message.
 *
 * "spawn claude ENOENT" is ambiguous in the one way that matters: it cannot
 * distinguish a lookup that found nothing from a resolved path that failed to
 * start. Reporting the target -- and how many places were searched -- turns a
 * dead end into something diagnosable from the UI that shows it.
 */
export function describeResolution(command: string, resolved: ResolvedCommand): string {
  if (resolved.command !== command) return `resolved to ${resolved.command}`
  return `unresolved: ${searchDirectories().length} directories searched, and where.exe found nothing spawnable`
}

export type WindowsCommandDiagnosis = {
  command: string
  platform: string
  pathEntries: number
  searchDirectories: number
  env: Record<string, string | null>
  /** Every place a candidate file was actually seen, and by which call. */
  sightings: Array<{ file: string; existsSync: boolean; statIsFile: boolean }>
  shim: { file: string; bytes: number | null; callLine: string | null; reference: string | null; target: string | null; targetSeen: boolean } | null
  where: { status: number | null; hits: string[]; error: string | null }
  resolved: ResolvedCommand
}

/**
 * Explain, step by step, what resolution saw.
 *
 * `existsSync` and `statSync` are reported separately on purpose: they answer
 * the same question through different syscalls, and a disagreement between them
 * is itself the finding. Everything here is read-only.
 */
export function diagnoseWindowsCommand(command: string): WindowsCommandDiagnosis {
  const directories = searchDirectories()
  const sightings: WindowsCommandDiagnosis['sightings'] = []
  for (const directory of directories) {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const file = path.join(directory, `${command}${extension}`)
      const byExists = existsSync(file)
      let byStat = false
      try { byStat = statSync(file).isFile() } catch { byStat = false }
      if (byExists || byStat) sightings.push({ file, existsSync: byExists, statIsFile: byStat })
    }
  }

  let shim: WindowsCommandDiagnosis['shim'] = null
  const shimFile = sightings.find(sighting => /\.(?:cmd|bat)$/iu.test(sighting.file))?.file
  if (shimFile) {
    let text: string | null = null
    try { text = readFileSync(shimFile, 'utf8') } catch { text = null }
    const callLine = text?.split(/\r?\n/).find(line => line.includes('%*')) ?? null
    const reference = callLine
      ? (/%~?dp0%\\?([^"\r\n]+?\.(?:exe|js|cjs|mjs))/i.exec(callLine)?.[1] ?? null)
      : null
    const target = reference ? path.resolve(path.dirname(shimFile), reference.trim()) : null
    shim = { file: shimFile, bytes: text === null ? null : text.length, callLine, reference, target, targetSeen: target ? existsSync(target) : false }
  }

  const where: WindowsCommandDiagnosis['where'] = { status: null, hits: [], error: null }
  try {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    where.status = result.status
    where.hits = String(result.stdout ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (result.error) where.error = result.error.message
  } catch (error) {
    where.error = error instanceof Error ? error.message : String(error)
  }

  return {
    command,
    platform: process.platform,
    pathEntries: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).length,
    searchDirectories: directories.length,
    env: {
      APPDATA: process.env.APPDATA ?? null,
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? null,
      USERPROFILE: process.env.USERPROFILE ?? null,
      ProgramFiles: process.env.ProgramFiles ?? null
    },
    sightings,
    shim,
    where,
    resolved: resolveWindowsCommand(command)
  }
}

function searchDirectories(): string[] {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const seen = new Set(fromPath.map(directory => directory.toLowerCase()))
  const extra = installerDirectories().filter(directory => !seen.has(directory.toLowerCase()))
  return [...fromPath, ...extra]
}

/**
 * Read the real call out of an npm shim. Only the line ending in `%*` is the
 * invocation; earlier lines mention paths (like a bundled node.exe) that may
 * not exist and must not be mistaken for the target.
 */
function shimTarget(shimPath: string, directories: string[]): ResolvedCommand | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }

  const callLine = text.split(/\r?\n/).find(line => line.includes('%*'))
  if (!callLine) return null
  const shimDirectory = path.dirname(shimPath)
  const resolve = (reference: string) => path.resolve(shimDirectory, reference.trim())

  // A node-forwarding shim: run the script with an interpreter we can find.
  const script = /%~?dp0%\\?([^"\r\n]+?\.(?:js|cjs|mjs))/i.exec(callLine)?.[1]
  if (script) {
    const scriptPath = resolve(script)
    if (!existsSync(scriptPath)) return null
    const bundled = path.join(shimDirectory, 'node.exe')
    const node = existsSync(bundled) ? bundled : findOnPath(directories, 'node.exe')
    return node ? { command: node, args: [scriptPath] } : null
  }

  const executable = /%~?dp0%\\?([^"\r\n]+?\.exe)/i.exec(callLine)?.[1]
  if (!executable) return null
  const executablePath = resolve(executable)
  return existsSync(executablePath) ? { command: executablePath, args: [] } : null
}

/**
 * Resolve a bare command name to something Windows can spawn without a shell.
 * Returns the command unchanged on other platforms, for paths, and whenever no
 * spawnable target is found, which leaves the caller's original failure intact
 * rather than inventing a new one.
 */
export function resolveWindowsCommand(command: string): ResolvedCommand {
  if (process.platform !== 'win32') return { command, args: [] }
  if (command.includes('/') || command.includes('\\')) return { command, args: [] }

  const directories = searchDirectories()

  // A real .exe on PATH wins outright: no shim reading, no interpreter.
  const direct = findOnPath(directories, `${command}.exe`)
  if (direct) return { command: direct, args: [] }

  for (const directory of directories) {
    for (const extension of ['.cmd', '.bat']) {
      const shim = path.join(directory, `${command}${extension}`)
      if (!existsSync(shim)) continue
      const target = shimTarget(shim, directories)
      if (target) return target
    }
  }

  return fromWhere(command, directories) ?? { command, args: [] }
}

/**
 * Last resort: ask Windows itself.
 *
 * Reading `process.env.PATH` is a reconstruction of the lookup, and it can
 * disagree with the search the OS would actually perform -- PATHEXT ordering,
 * per-process environment differences, App Paths. `where.exe` performs the real
 * lookup in the real process environment, which is why the Antigravity adapter
 * finds its CLI through it in situations where scanning PATH comes up empty.
 * Only the shim reading above can turn a `.cmd` hit into something spawnable
 * without a shell, so the answers are fed back through it.
 */
function fromWhere(command: string, directories: string[]): ResolvedCommand | null {
  let hits: string[]
  try {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return null
    hits = String(result.stdout ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  } catch {
    return null
  }

  for (const hit of hits) {
    if (/\.exe$/iu.test(hit) && existsSync(hit)) return { command: hit, args: [] }
    if (/\.(?:cmd|bat)$/iu.test(hit) && existsSync(hit)) {
      const target = shimTarget(hit, directories)
      if (target) return target
    }
  }
  return null
}
