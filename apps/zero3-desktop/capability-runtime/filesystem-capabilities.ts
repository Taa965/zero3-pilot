import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file.ts'
import type { Zero3CapabilityDefinition, Zero3CapabilityHandler } from './contracts.ts'
import { Zero3CapabilityPathError, Zero3CapabilityPathResolver } from './path-safety.ts'

// The MCP gateway body cap is 2 MiB and the JSON envelope has to fit inside it,
// so every payload-bearing capability bounds itself first. Waiting for the HTTP
// layer to truncate would hand the model a silently corrupted result.
export const MAX_LIST_ENTRIES = 1000
export const DEFAULT_LIST_LIMIT = 200
export const MAX_LIST_DEPTH = 6
export const MAX_READ_BYTES = 1024 * 1024
export const MAX_WRITE_BYTES = 1024 * 1024
export const MAX_COPY_ENTRIES = 5000

export type Zero3FileSystemEntry = {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  sizeBytes?: number
  modifiedAt?: string
}

export type Zero3FileSystemCapabilitiesOptions = {
  nodeId: string
  roots: readonly string[]
  cwd?: string
}

type RegisteredCapability = { definition: Zero3CapabilityDefinition; handler: Zero3CapabilityHandler }

function capabilityError(code: string, message: string): Zero3CapabilityPathError {
  return new Zero3CapabilityPathError(code, message)
}

function text(value: unknown, label: string, minLength: number, maxLength: number): string {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length < minLength) throw capabilityError('INVALID_INPUT', `${label} must contain at least ${minLength} characters`)
  if (raw.length > maxLength) throw capabilityError('INVALID_INPUT', `${label} must contain at most ${maxLength} characters`)
  return raw
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value == null) return undefined
  return text(value, label, 1, maxLength)
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw capabilityError('INVALID_INPUT', `${label} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function normalizedSha(value: unknown): string | undefined {
  const raw = optionalText(value, 'expectedSha256', 64)
  if (raw === undefined) return undefined
  const lowered = raw.toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(lowered)) throw capabilityError('INVALID_INPUT', 'expectedSha256 must be a 64 character hex digest')
  return lowered
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  for (const byte of sample) if (byte === 0) return true
  return false
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

async function directoryIsEmpty(target: string): Promise<boolean> {
  return (await fs.promises.readdir(target)).length === 0
}

function kindOf(stats: fs.Stats): Zero3FileSystemEntry['kind'] {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  return 'other'
}

function entryOf(target: string, stats: fs.Stats): Zero3FileSystemEntry {
  const kind = kindOf(stats)
  const entry: Zero3FileSystemEntry = { name: path.basename(target), path: target, kind }
  if (kind === 'file') entry.sizeBytes = stats.size
  entry.modifiedAt = stats.mtime.toISOString()
  return entry
}

function definition(
  nodeId: string,
  id: string,
  name: string,
  description: string,
  supportsCancellation: boolean,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>
): Zero3CapabilityDefinition {
  return {
    protocol: 'zero3.remote-capability.v1',
    id,
    version: '1.0',
    name,
    description,
    category: 'filesystem',
    status: 'available',
    executionMode: 'local',
    supportsStreaming: false,
    supportsCancellation,
    requiresApproval: 'policy',
    provider: 'zero3-local',
    nodeId,
    inputSchema,
    outputSchema
  }
}

const PATH_INPUT = { type: 'string', minLength: 1, maxLength: 32768 }

/**
 * Filesystem capabilities execute exclusively on the local Zero3 host. The
 * plugin, the MCP layer and the AWS gateway only relay the invocation; they
 * never touch the disk themselves.
 */
export function createZero3FileSystemCapabilities(
  options: Zero3FileSystemCapabilitiesOptions
): RegisteredCapability[] {
  const resolver = new Zero3CapabilityPathResolver(options.roots, options.cwd ?? process.cwd())

  const listHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path', mustExist: true })
    const recursive = boolean(invocation.input.recursive, false)
    const limit = integer(invocation.input.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_ENTRIES, 'limit')
    const depth = recursive ? integer(invocation.input.depth, MAX_LIST_DEPTH, 1, MAX_LIST_DEPTH, 'depth') : 1

    const stats = await fs.promises.stat(target.absolute)
    if (!stats.isDirectory()) throw capabilityError('NOT_A_DIRECTORY', 'path is not a directory')

    const entries: Zero3FileSystemEntry[] = []
    const queue: Array<{ directory: string; level: number }> = [{ directory: target.absolute, level: 0 }]
    let truncated = false

    while (queue.length > 0 && !truncated) {
      const current = queue.shift() as { directory: string; level: number }
      const dirents = await fs.promises.readdir(current.directory, { withFileTypes: true })
      dirents.sort((left, right) => left.name.localeCompare(right.name))
      for (const dirent of dirents) {
        if (entries.length >= limit) {
          truncated = true
          break
        }
        const child = path.join(current.directory, dirent.name)
        const childStats = await fs.promises.lstat(child)
        const entry = entryOf(child, childStats)
        entries.push(entry)
        if (!recursive || entry.kind !== 'directory') continue
        if (current.level + 1 >= depth) continue
        // Never follow a link out of the workspace: re-verify containment before
        // descending instead of trusting that the parent was inside the root.
        try {
          await resolver.resolve(child, { label: 'entry' })
        } catch (error) {
          if (error instanceof Zero3CapabilityPathError && (error.code === 'SYMLINK_ESCAPE' || error.code === 'PATH_OUTSIDE_ALLOWED_ROOTS')) {
            continue
          }
          throw error
        }
        queue.push({ directory: child, level: current.level + 1 })
      }
    }

    return { path: target.absolute, recursive, depth, limit, count: entries.length, truncated, entries }
  }

  const statHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path' })
    const stats = await statOrNull(target.absolute)
    if (!stats) {
      // A missing path is a normal answer, not an ENOENT stack for the model to
      // parse. The shape stays stable so callers can branch on `exists`.
      return {
        path: target.absolute,
        exists: false,
        kind: 'missing',
        sizeBytes: null,
        createdAt: null,
        modifiedAt: null,
        readonly: null,
        symlink: false
      }
    }
    const kind = kindOf(stats)
    return {
      path: target.absolute,
      exists: true,
      kind,
      sizeBytes: kind === 'file' ? stats.size : null,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      readonly: (stats.mode & 0o200) === 0,
      symlink: stats.isSymbolicLink()
    }
  }

  const readHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path', mustExist: true })
    const maxBytes = integer(invocation.input.maxBytes, MAX_READ_BYTES, 1, MAX_READ_BYTES, 'maxBytes')
    const stats = await fs.promises.stat(target.absolute)
    if (!stats.isFile()) throw capabilityError('NOT_A_FILE', 'path is not a regular file')
    if (stats.size > maxBytes) {
      throw capabilityError(
        'FILE_TOO_LARGE',
        `file is ${stats.size} bytes which exceeds the ${maxBytes} byte read limit; no content was returned`
      )
    }
    const buffer = await fs.promises.readFile(target.absolute)
    if (looksBinary(buffer)) {
      throw capabilityError('UNSUPPORTED_BINARY', 'file appears to be binary; P1 filesystem.read only transports UTF-8 text')
    }
    const content = buffer.toString('utf8')
    // Round-tripping catches text that decoded with replacement characters, i.e.
    // a non-UTF-8 encoding we must not silently mangle.
    if (!Buffer.from(content, 'utf8').equals(buffer)) {
      throw capabilityError('UNSUPPORTED_ENCODING', 'file is not valid UTF-8; P1 filesystem.read only transports UTF-8 text')
    }
    return {
      path: target.absolute,
      sizeBytes: buffer.length,
      encoding: 'utf8',
      content,
      sha256: sha256Of(buffer)
    }
  }

  const writeHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path' })
    if (typeof invocation.input.content !== 'string') throw capabilityError('INVALID_INPUT', 'content must be a string')
    const content = invocation.input.content
    if (content.length > MAX_WRITE_BYTES) {
      throw capabilityError('FILE_TOO_LARGE', `content exceeds the ${MAX_WRITE_BYTES} character write limit`)
    }
    const encoding = optionalText(invocation.input.encoding, 'encoding', 16) ?? 'utf8'
    if (encoding !== 'utf8') throw capabilityError('UNSUPPORTED_ENCODING', `encoding ${encoding} is not supported; use utf8`)
    const createParents = boolean(invocation.input.createParents, true)
    const overwrite = boolean(invocation.input.overwrite, true)
    const expectedSha256 = normalizedSha(invocation.input.expectedSha256)
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_WRITE_BYTES) {
      throw capabilityError('FILE_TOO_LARGE', `content is ${bytes.length} bytes which exceeds the ${MAX_WRITE_BYTES} byte write limit`)
    }

    const existing = await statOrNull(target.absolute)
    if (existing?.isDirectory()) throw capabilityError('IS_A_DIRECTORY', 'path is a directory')
    if (existing && !overwrite) throw capabilityError('FILE_EXISTS', 'path already exists and overwrite is false')

    if (expectedSha256) {
      // Optimistic concurrency: the caller read the file (and its digest) and is
      // refusing to clobber a write it did not observe. Missing counts as changed.
      if (!existing) throw capabilityError('FILE_CHANGED', 'expectedSha256 was supplied but the file does not exist')
      const actual = sha256Of(await fs.promises.readFile(target.absolute))
      if (actual !== expectedSha256) {
        throw capabilityError('FILE_CHANGED', `file content changed since it was read (expected ${expectedSha256}, found ${actual})`)
      }
    }

    if (!createParents) {
      const parent = await statOrNull(path.dirname(target.absolute))
      if (!parent?.isDirectory()) throw capabilityError('PARENT_MISSING', 'parent directory does not exist and createParents is false')
    }

    // Reuse the repository's atomic writer (temp file -> fsync -> rename) so this
    // capability cannot introduce a second, weaker atomic-write implementation.
    await zero3AtomicWriteFile(target.absolute, content)
    return {
      path: target.absolute,
      encoding: 'utf8',
      sizeBytes: bytes.length,
      sha256: sha256Of(bytes),
      created: !existing,
      overwritten: Boolean(existing)
    }
  }

  const mkdirHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path' })
    const recursive = boolean(invocation.input.recursive, true)
    const existing = await statOrNull(target.absolute)
    if (existing) {
      if (existing.isDirectory()) return { path: target.absolute, created: false, recursive }
      throw capabilityError('NOT_A_DIRECTORY', 'path exists and is not a directory')
    }
    if (!recursive) {
      const parent = await statOrNull(path.dirname(target.absolute))
      if (!parent?.isDirectory()) throw capabilityError('PARENT_MISSING', 'parent directory does not exist and recursive is false')
    }
    await fs.promises.mkdir(target.absolute, { recursive })
    return { path: target.absolute, created: true, recursive }
  }

  const copyHandler: Zero3CapabilityHandler = async invocation => {
    const from = await resolver.resolve(invocation.input.from, { label: 'from', mustExist: true })
    const to = await resolver.resolve(invocation.input.to, { label: 'to' })
    const overwrite = boolean(invocation.input.overwrite, false)
    const recursive = boolean(invocation.input.recursive, false)

    const sourceStats = await fs.promises.lstat(from.absolute)
    if (sourceStats.isSymbolicLink()) throw capabilityError('SYMLINK_COPY_UNSUPPORTED', 'refusing to copy a symbolic link or reparse point')
    if (isInside(from.absolute, to.absolute)) throw capabilityError('INVALID_DESTINATION', 'destination is inside the source')

    if (!sourceStats.isDirectory()) {
      if (!sourceStats.isFile()) throw capabilityError('NOT_A_FILE', 'from is not a regular file')
      const destination = await statOrNull(to.absolute)
      if (destination?.isDirectory()) throw capabilityError('IS_A_DIRECTORY', 'destination is a directory')
      if (destination && !overwrite) throw capabilityError('FILE_EXISTS', 'destination already exists and overwrite is false')
      await fs.promises.copyFile(from.absolute, to.absolute, overwrite ? 0 : fs.constants.COPYFILE_EXCL)
      return { from: from.absolute, to: to.absolute, kind: 'file', entriesCopied: 1, bytesCopied: sourceStats.size }
    }

    if (!recursive) throw capabilityError('DIRECTORY_COPY_REQUIRES_RECURSIVE', 'from is a directory; pass recursive: true')

    let entriesCopied = 0
    let bytesCopied = 0
    const queue: Array<{ source: string; destination: string }> = [{ source: from.absolute, destination: to.absolute }]
    while (queue.length > 0) {
      const current = queue.shift() as { source: string; destination: string }
      await fs.promises.mkdir(current.destination, { recursive: true })
      const dirents = await fs.promises.readdir(current.source, { withFileTypes: true })
      dirents.sort((left, right) => left.name.localeCompare(right.name))
      for (const dirent of dirents) {
        entriesCopied += 1
        if (entriesCopied > MAX_COPY_ENTRIES) {
          throw capabilityError('COPY_TOO_LARGE', `copy exceeds the ${MAX_COPY_ENTRIES} entry limit`)
        }
        const sourceChild = path.join(current.source, dirent.name)
        const destinationChild = path.join(current.destination, dirent.name)
        const childStats = await fs.promises.lstat(sourceChild)
        if (childStats.isSymbolicLink()) throw capabilityError('SYMLINK_COPY_UNSUPPORTED', 'refusing to copy a symbolic link or reparse point')
        if (childStats.isDirectory()) {
          queue.push({ source: sourceChild, destination: destinationChild })
          continue
        }
        if (!childStats.isFile()) throw capabilityError('NOT_A_FILE', `unsupported entry type: ${sourceChild}`)
        const destinationStats = await statOrNull(destinationChild)
        if (destinationStats && !overwrite) throw capabilityError('FILE_EXISTS', `destination already exists and overwrite is false: ${destinationChild}`)
        await fs.promises.copyFile(sourceChild, destinationChild, overwrite ? 0 : fs.constants.COPYFILE_EXCL)
        bytesCopied += childStats.size
      }
    }
    return { from: from.absolute, to: to.absolute, kind: 'directory', entriesCopied, bytesCopied }
  }

  const moveHandler: Zero3CapabilityHandler = async invocation => {
    const from = await resolver.resolve(invocation.input.from, { label: 'from', mustExist: true })
    const to = await resolver.resolve(invocation.input.to, { label: 'to' })
    const overwrite = boolean(invocation.input.overwrite, false)

    if (isInside(from.absolute, to.absolute)) throw capabilityError('INVALID_DESTINATION', 'destination is inside the source')
    const sourceStats = await fs.promises.lstat(from.absolute)
    const destination = await statOrNull(to.absolute)
    if (destination && !overwrite) throw capabilityError('FILE_EXISTS', 'destination already exists and overwrite is false')
    if (destination?.isDirectory() && !sourceStats.isDirectory()) {
      throw capabilityError('IS_A_DIRECTORY', 'destination is a directory')
    }
    if (destination && overwrite) {
      // Windows rename() refuses to replace an existing target, so an explicit
      // overwrite removes it first. This is the only delete the move performs.
      await fs.promises.rm(to.absolute, { recursive: destination.isDirectory(), force: true })
    }
    try {
      await fs.promises.rename(from.absolute, to.absolute)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        throw capabilityError('CROSS_DEVICE_MOVE_UNSUPPORTED', 'from and to are on different volumes; use filesystem.copy followed by filesystem.delete')
      }
      throw error
    }
    return { from: from.absolute, to: to.absolute, kind: kindOf(sourceStats), overwritten: Boolean(destination) }
  }

  const deleteHandler: Zero3CapabilityHandler = async invocation => {
    const target = await resolver.resolve(invocation.input.path, { label: 'path', mustExist: true })
    const recursive = boolean(invocation.input.recursive, false)

    // Deleting a configured root, or a volume root, would remove the sandbox
    // itself. Refuse before any filesystem call.
    if (resolver.isAllowedRoot(target.absolute)) throw capabilityError('CANNOT_DELETE_ALLOWED_ROOT', 'path is a locally allow-listed Zero3 root')
    if (path.parse(target.absolute).root === target.absolute) throw capabilityError('CANNOT_DELETE_VOLUME_ROOT', 'path is a volume root')

    const stats = await fs.promises.lstat(target.absolute)
    if (stats.isDirectory()) {
      if (!recursive) {
        if (!(await directoryIsEmpty(target.absolute))) {
          throw capabilityError('DIRECTORY_NOT_EMPTY', 'path is a non-empty directory; pass recursive: true to remove it')
        }
        await fs.promises.rmdir(target.absolute)
      } else {
        await fs.promises.rm(target.absolute, { recursive: true, force: false })
      }
    } else {
      await fs.promises.rm(target.absolute, { force: false })
    }
    return { path: target.absolute, kind: kindOf(stats), recursive, deleted: true }
  }

  return [
    {
      definition: definition(
        options.nodeId,
        'filesystem.list',
        'List a local Zero3 directory',
        'List directory entries on the local Zero3 host, bounded by an entry limit and an optional recursion depth.',
        true,
        {
          type: 'object',
          properties: {
            path: PATH_INPUT,
            recursive: { type: 'boolean', default: false },
            depth: { type: 'integer', minimum: 1, maximum: MAX_LIST_DEPTH },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_ENTRIES }
          },
          required: ['path'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            path: { type: 'string' }, recursive: { type: 'boolean' }, depth: { type: 'integer' },
            limit: { type: 'integer' }, count: { type: 'integer' }, truncated: { type: 'boolean' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, path: { type: 'string' },
                  kind: { enum: ['file', 'directory', 'symlink', 'other'] },
                  sizeBytes: { type: 'integer' }, modifiedAt: { type: 'string' }
                }
              }
            }
          }
        }
      ),
      handler: listHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.stat',
        'Stat a local Zero3 path',
        'Return a stable description of a local Zero3 path. A missing path is reported as exists:false rather than an error.',
        false,
        { type: 'object', properties: { path: PATH_INPUT }, required: ['path'], additionalProperties: false },
        {
          type: 'object',
          properties: {
            path: { type: 'string' }, exists: { type: 'boolean' },
            kind: { enum: ['file', 'directory', 'symlink', 'other', 'missing'] },
            sizeBytes: { type: ['integer', 'null'] }, createdAt: { type: ['string', 'null'] },
            modifiedAt: { type: ['string', 'null'] }, readonly: { type: ['boolean', 'null'] }, symlink: { type: 'boolean' }
          }
        }
      ),
      handler: statHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.read',
        'Read a UTF-8 text file on the local Zero3 host',
        'Read a bounded UTF-8 text file from the local Zero3 host and return its sha256 so a later write can be made conflict-safe.',
        true,
        {
          type: 'object',
          properties: { path: PATH_INPUT, encoding: { enum: ['utf8'] }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } },
          required: ['path'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            path: { type: 'string' }, sizeBytes: { type: 'integer' },
            encoding: { type: 'string' }, content: { type: 'string' }, sha256: { type: 'string' }
          }
        }
      ),
      handler: readHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.write',
        'Write a UTF-8 text file on the local Zero3 host',
        'Atomically write a bounded UTF-8 text file on the local Zero3 host. Pass expectedSha256 to fail closed when another session changed the file first.',
        false,
        {
          type: 'object',
          properties: {
            path: PATH_INPUT,
            content: { type: 'string', maxLength: MAX_WRITE_BYTES },
            encoding: { enum: ['utf8'] },
            createParents: { type: 'boolean', default: true },
            overwrite: { type: 'boolean', default: true },
            expectedSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' }
          },
          required: ['path', 'content'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            path: { type: 'string' }, encoding: { type: 'string' }, sizeBytes: { type: 'integer' },
            sha256: { type: 'string' }, created: { type: 'boolean' }, overwritten: { type: 'boolean' }
          }
        }
      ),
      handler: writeHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.mkdir',
        'Create a directory on the local Zero3 host',
        'Create a directory on the local Zero3 host. Creating an existing directory is reported as created:false.',
        false,
        {
          type: 'object',
          properties: { path: PATH_INPUT, recursive: { type: 'boolean', default: true } },
          required: ['path'],
          additionalProperties: false
        },
        { type: 'object', properties: { path: { type: 'string' }, created: { type: 'boolean' }, recursive: { type: 'boolean' } } }
      ),
      handler: mkdirHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.copy',
        'Copy a file or directory on the local Zero3 host',
        'Copy a file, or a directory tree when recursive is set, on the local Zero3 host. Symbolic links are never followed.',
        true,
        {
          type: 'object',
          properties: {
            from: PATH_INPUT, to: PATH_INPUT,
            overwrite: { type: 'boolean', default: false },
            recursive: { type: 'boolean', default: false }
          },
          required: ['from', 'to'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            from: { type: 'string' }, to: { type: 'string' },
            kind: { enum: ['file', 'directory'] },
            entriesCopied: { type: 'integer' }, bytesCopied: { type: 'integer' }
          }
        }
      ),
      handler: copyHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.move',
        'Move or rename a path on the local Zero3 host',
        'Rename a file or directory on the local Zero3 host. Cross-volume moves are refused instead of degrading into a copy plus delete.',
        true,
        {
          type: 'object',
          properties: { from: PATH_INPUT, to: PATH_INPUT, overwrite: { type: 'boolean', default: false } },
          required: ['from', 'to'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            from: { type: 'string' }, to: { type: 'string' },
            kind: { enum: ['file', 'directory', 'symlink', 'other'] },
            overwritten: { type: 'boolean' }
          }
        }
      ),
      handler: moveHandler
    },
    {
      definition: definition(
        options.nodeId,
        'filesystem.delete',
        'Delete a path on the local Zero3 host',
        'Delete a file or directory on the local Zero3 host. A non-empty directory requires recursive:true, and allow-listed roots can never be deleted.',
        true,
        {
          type: 'object',
          properties: { path: PATH_INPUT, recursive: { type: 'boolean', default: false } },
          required: ['path'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            path: { type: 'string' },
            kind: { enum: ['file', 'directory', 'symlink', 'other'] },
            recursive: { type: 'boolean' }, deleted: { type: 'boolean' }
          }
        }
      ),
      handler: deleteHandler
    }
  ]
}

// Lexical helper shared with the copy/move self-containment guard.
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
