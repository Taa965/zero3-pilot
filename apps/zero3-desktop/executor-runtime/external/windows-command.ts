import { existsSync, readFileSync } from 'node:fs'
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

  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

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

  return { command, args: [] }
}
