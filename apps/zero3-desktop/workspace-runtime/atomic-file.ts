import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Windows fails rename() with EPERM/EACCES/EBUSY whenever another handle is
// open on the destination. Real-time antivirus, the search indexer and Explorer
// preview all open freshly written JSON for a few hundred milliseconds, so a
// single-shot atomic replace loses that race often enough to break user actions
// (a failed workspace-entry write surfaces as "cannot create a GPT web tab").
// The contention is transient, so retry the replace instead of failing the call.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640]

// A write that never completed leaves its temporary sibling behind. Anything
// older than this cannot belong to an in-flight write by any process.
const STALE_TEMPORARY_AGE_MS = 60 * 60 * 1_000
const sweptTargets = new Set<string>()

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? ''
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !RETRYABLE_RENAME_CODES.has(errorCode(error))) throw error
      await delay(RENAME_RETRY_DELAYS_MS[attempt] as number)
    }
  }
}

// Best effort, and only once per target per process: a leaked temporary is never
// read back, so failing to remove one must not fail the write that found it.
async function sweepStaleTemporaries(file: string): Promise<void> {
  if (sweptTargets.has(file)) return
  sweptTargets.add(file)
  try {
    const directory = path.dirname(file)
    const prefix = `${path.basename(file)}.tmp-`
    const cutoff = Date.now() - STALE_TEMPORARY_AGE_MS
    for (const name of await fs.readdir(directory)) {
      if (!name.startsWith(prefix)) continue
      const candidate = path.join(directory, name)
      const stats = await fs.stat(candidate).catch(() => null)
      if (!stats || !stats.isFile() || stats.mtimeMs > cutoff) continue
      await fs.rm(candidate, { force: true }).catch(() => undefined)
    }
  } catch {
    // Sweeping is opportunistic; a directory problem is reported by the write.
  }
}

/**
 * Replace `file` with `text` atomically, tolerating the transient Windows file
 * locks that make a bare write-then-rename unreliable. The temporary sibling is
 * always removed, so a failed write never leaks state into the data directory.
 *
 * The content is flushed to disk before the rename. Without that an atomic
 * rename only promises the name flips atomically, not that the bytes behind it
 * survive a power loss -- and the crash-recovery stores that share this helper
 * (the remote outbox, handoff checkpoints) exist precisely for that case.
 * `wx` makes the temporary an exclusive create, so two writers can never end up
 * appending into the same sibling.
 */
export async function zero3AtomicWriteFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await sweepStaleTemporaries(file)
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
