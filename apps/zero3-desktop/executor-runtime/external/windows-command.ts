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
// argument. npm's shim is a small batch file that forwards to a real
// executable, so reading the target out of it yields a path that spawns with no
// shell at all. Anything unresolvable is returned unchanged, which leaves the
// caller's original failure intact rather than inventing a new one.

/** Pull the forwarded executable out of an npm-style `"%dp0%\...exe" %*` shim. */
function shimTarget(shimPath: string): string | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const match = /%~?dp0%\\?([^"\r\n]+?\.exe)/i.exec(text)
  if (!match?.[1]) return null
  const target = path.resolve(path.dirname(shimPath), match[1].trim())
  return existsSync(target) ? target : null
}

/**
 * Resolve a bare command name to something Windows can spawn without a shell.
 * Returns `command` unchanged on other platforms, for paths, and whenever no
 * spawnable target is found.
 */
export function resolveWindowsCommand(command: string): string {
  if (process.platform !== 'win32') return command
  if (command.includes('/') || command.includes('\\')) return command

  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

  // A real .exe wins outright: it needs no shim reading and no shell.
  for (const directory of directories) {
    const executable = path.join(directory, `${command}.exe`)
    if (existsSync(executable)) return executable
  }

  for (const directory of directories) {
    for (const extension of ['.cmd', '.bat']) {
      const target = shimTarget(path.join(directory, `${command}${extension}`))
      if (target) return target
    }
  }

  return command
}
