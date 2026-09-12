import fs from 'node:fs'
import path from 'node:path'

// Every remote capability that names a path on the local Zero3 host resolves it
// through this module. Doing it in one place is the only way the containment
// rule stays honest: a handler that calls path.resolve() on its own will happily
// accept C:\Windows or a symlink that points out of the workspace.

const WINDOWS = process.platform === 'win32'
const UNC_ABSOLUTE = /^[\\/]{2}[^\\/]/u
const MAX_PATH_LENGTH = 32768

export type Zero3CapabilityEnvironment = Record<string, string | undefined>

export class Zero3CapabilityPathError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'Zero3CapabilityPathError'
    this.code = code
  }
}

/**
 * Operator-owned allow-list. It reuses the roots the remote-host runtime already
 * publishes so a single ZERO3_* configuration governs both surfaces.
 */
export function parseCapabilityAllowedRoots(env: Zero3CapabilityEnvironment): string[] {
  const raw = [env.ZERO3_CAPABILITY_ALLOWED_ROOTS, env.ZERO3_REMOTE_HOST_WORKSPACES, env.ZERO3_CODEX_CWD]
    .filter((value): value is string => Boolean(value))
    .join(';')
  const unique = new Map<string, string>()
  for (const item of raw.split(';').map(value => value.trim()).filter(Boolean)) {
    const resolved = path.resolve(item)
    unique.set(compareKey(resolved), resolved)
  }
  return [...unique.values()]
}

// Windows paths are case-insensitive, and a caller that types C:\Repo while the
// root is configured as c:\repo must not be treated as an escape.
function compareKey(value: string): string {
  return WINDOWS ? value.toLowerCase() : value
}

/**
 * Containment by path.relative, never by string prefix. A prefix test accepts
 * `C:\project-evil` for the root `C:\project`; path.relative cannot.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(compareKey(path.resolve(root)), compareKey(path.resolve(candidate)))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Resolve a path to its real location, tolerating a tail that does not exist
 * yet (filesystem.write with createParents, filesystem.mkdir). The deepest
 * existing ancestor is resolved through the platform (so symlinks, junctions and
 * 8.3 short names are all followed) and the missing tail is appended verbatim.
 */
async function realPathAllowingMissing(target: string): Promise<string> {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await fs.promises.realpath(current)
      return tail.length ? path.join(real, ...tail) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Zero3CapabilityPathError('PATH_UNRESOLVABLE', `cannot resolve ${current} (${code ?? 'unknown error'})`)
      }
      const parent = path.dirname(current)
      if (parent === current) return tail.length ? path.join(current, ...tail) : current
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

export type Zero3ResolvedPath = {
  requested: string
  absolute: string
  real: string
  root: string
}

export type Zero3ResolvePathOptions = {
  label?: string
  mustExist?: boolean
}

export class Zero3CapabilityPathResolver {
  private readonly roots: string[]

  constructor(roots: readonly string[], private readonly cwd: string = process.cwd()) {
    this.roots = roots.map(root => path.resolve(root))
  }

  get allowedRoots(): readonly string[] {
    return [...this.roots]
  }

  isAllowedRoot(candidate: string): boolean {
    return this.roots.some(root => compareKey(root) === compareKey(path.resolve(candidate)))
  }

  async resolve(value: unknown, options: Zero3ResolvePathOptions = {}): Promise<Zero3ResolvedPath> {
    const label = options.label ?? 'path'
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) throw new Zero3CapabilityPathError('PATH_REQUIRED', `${label} is required`)
    if (raw.length > MAX_PATH_LENGTH) throw new Zero3CapabilityPathError('PATH_INVALID', `${label} is too long`)
    if (/[\0\r\n]/u.test(raw)) throw new Zero3CapabilityPathError('PATH_INVALID', `${label} contains control characters`)

    // path.resolve collapses `.`/`..`, so a traversal attempt lands outside the
    // roots and is rejected by the containment check below rather than by a
    // brittle "does the string contain .." rule.
    const absolute = path.resolve(this.cwd, raw)
    if (UNC_ABSOLUTE.test(absolute) && !this.roots.some(root => UNC_ABSOLUTE.test(root))) {
      throw new Zero3CapabilityPathError('UNC_PATH_NOT_ALLOWED', `${label} is a UNC path and no UNC root is allow-listed`)
    }

    const root = this.roots.find(candidate => isInsideRoot(candidate, absolute))
    if (!root) {
      throw new Zero3CapabilityPathError('PATH_OUTSIDE_ALLOWED_ROOTS', `${label} is outside the locally allow-listed Zero3 roots`)
    }

    if (options.mustExist && !(await lstatOrNull(absolute))) {
      throw new Zero3CapabilityPathError('PATH_NOT_FOUND', `${label} does not exist`)
    }

    // Lexical containment is not enough: C:\project\link -> C:\Windows passes the
    // check above. Re-check after resolving every symlink/junction in the path.
    const realRoot = await realPathAllowingMissing(root)
    const real = await realPathAllowingMissing(absolute)
    if (!isInsideRoot(realRoot, real)) {
      throw new Zero3CapabilityPathError('SYMLINK_ESCAPE', `${label} resolves outside the allow-listed Zero3 roots`)
    }

    return { requested: raw, absolute, real, root }
  }
}
