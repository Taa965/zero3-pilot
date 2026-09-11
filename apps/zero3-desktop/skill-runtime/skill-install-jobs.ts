import fs from 'node:fs/promises'
import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file'

export type Zero3SkillInstallJobStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'needs_recovery'

export type Zero3SkillInstallJob = {
  threadId: string
  source: string
  cwd: string | null
  destination: string
  status: Zero3SkillInstallJobStatus
  startedAt: string
  updatedAt: string
  endedAt: string | null
  error: string | null
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_JOBS = 50
const TERMINAL_STATUSES = new Set<Zero3SkillInstallJobStatus>(['completed', 'failed', 'interrupted'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function text(value: unknown, label: string, max = 4096): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}

// The native installer runs as a Codex Turn whose approval requests live only
// inside the app-server process. This store keeps the install *task* itself on
// disk so a renderer reload can re-attach to its pending approvals and a full
// app restart can surface the interrupted install instead of dropping it. It
// never stores Skill files or bodies -- only the installer task envelope.
export class Zero3SkillInstallJobStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  async list(): Promise<Zero3SkillInstallJob[]> {
    try {
      const buffer = await fs.readFile(this.file)
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Skill install job store exceeds size limit')
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown
      if (!Array.isArray(parsed)) throw new Error('Skill install job store is invalid')
      return clone(parsed.filter(isJob))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  record(input: { threadId: string; source: string; cwd?: string | null; destination: string; status?: Zero3SkillInstallJobStatus }): Promise<Zero3SkillInstallJob> {
    return this.mutate(async () => {
      const current = await this.list()
      const now = new Date().toISOString()
      const threadId = text(input.threadId, 'threadId', 256)
      const job: Zero3SkillInstallJob = {
        threadId,
        source: text(input.source, 'source'),
        cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : null,
        destination: text(input.destination, 'destination'),
        status: input.status === 'needs_recovery' ? 'needs_recovery' : 'running',
        startedAt: current.find(job => job.threadId === threadId)?.startedAt ?? now,
        updatedAt: now,
        endedAt: null,
        error: null
      }
      await this.write([...current.filter(job => job.threadId !== threadId), job])
      return clone(job)
    })
  }

  update(threadId: unknown, patch: { status: Zero3SkillInstallJobStatus; error?: string | null }): Promise<Zero3SkillInstallJob | null> {
    return this.mutate(async () => {
      const id = text(threadId, 'threadId', 256)
      const current = await this.list()
      const existing = current.find(job => job.threadId === id)
      if (!existing) return null
      const now = new Date().toISOString()
      const terminal = TERMINAL_STATUSES.has(patch.status) || patch.status === 'needs_recovery'
      const next: Zero3SkillInstallJob = {
        ...existing,
        status: patch.status,
        error: patch.error != null && patch.error !== '' ? patch.error.slice(0, 2_000) : null,
        endedAt: terminal ? now : null,
        updatedAt: now
      }
      await this.write([...current.filter(job => job.threadId !== id), next].slice(-MAX_JOBS))
      return clone(next)
    })
  }

  // Called once per app launch: the Codex Turn and its approval requests die
  // with the app-server process, so a job still marked running can only be
  // surfaced again as an interrupted install the user chooses to re-run.
  async recoverInterrupted(): Promise<Zero3SkillInstallJob[]> {
    return this.mutate(async () => {
      const current = await this.list()
      const now = new Date().toISOString()
      let changed = false
      const next = current.map(job => {
        if (job.status !== 'running') return job
        changed = true
        return { ...job, status: 'needs_recovery' as const, endedAt: now, updatedAt: now, error: '应用重启中断了安装任务，请重新安装。' }
      })
      if (changed) await this.write(next)
      return next.filter(job => job.status === 'needs_recovery')
    })
  }

  async remove(threadId: unknown): Promise<boolean> {
    return this.mutate(async () => {
      const id = text(threadId, 'threadId', 256)
      const current = await this.list()
      const next = current.filter(job => job.threadId !== id)
      if (next.length === current.length) return false
      await this.write(next)
      return true
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async write(jobs: Zero3SkillInstallJob[]) {
    const body = `${JSON.stringify(jobs, null, 2)}\n`
    if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) throw new Error('Skill install job store exceeds size limit')
    await zero3AtomicWriteFile(this.file, body)
  }
}

function isJob(value: unknown): value is Zero3SkillInstallJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  return typeof job.threadId === 'string' && job.threadId.trim().length > 0
    && typeof job.source === 'string'
    && typeof job.destination === 'string'
    && typeof job.status === 'string'
}
