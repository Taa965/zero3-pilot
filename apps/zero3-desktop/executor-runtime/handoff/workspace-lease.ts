import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { HandoffVerificationResult } from './handoff-types.ts'

export interface WorkspaceWriterLease {
  task_id: string
  execution_id: string
  workspace: string
  executor_id: string
  generation: number
  lease_nonce: string
  state: 'active' | 'handoff_pending'
  updated_at: string
}

async function writeAtomic(file: string, value: WorkspaceWriterLease): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
}

async function createExclusive(file: string, value: WorkspaceWriterLease): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class WorkspaceWriterGate {
  readonly file: string

  constructor(workspace: string) {
    this.file = path.join(path.resolve(workspace), '.zero3-pilot', 'handoff', 'writer-lease.json')
  }

  async current(): Promise<WorkspaceWriterLease | undefined> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as WorkspaceWriterLease
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async acquire(taskId: string, executionId: string, workspace: string, executorId: string, generation: number): Promise<WorkspaceWriterLease> {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('writer generation must be positive')
    const lease: WorkspaceWriterLease = {
      task_id: taskId,
      execution_id: executionId,
      workspace: path.resolve(workspace),
      executor_id: executorId,
      generation,
      lease_nonce: randomUUID(),
      state: 'active',
      updated_at: new Date().toISOString()
    }
    try {
      await createExclusive(this.file, lease)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('workspace already has an active or pending writer lease')
      }
      throw error
    }
    return lease
  }

  async beginHandoff(expected: WorkspaceWriterLease): Promise<WorkspaceWriterLease> {
    const current = await this.requireMatch(expected)
    const pending = { ...current, state: 'handoff_pending' as const, updated_at: new Date().toISOString() }
    await writeAtomic(this.file, pending)
    return pending
  }

  async acceptHandoff(
    expected: WorkspaceWriterLease,
    nextExecutorId: string,
    verification: HandoffVerificationResult
  ): Promise<WorkspaceWriterLease> {
    const current = await this.requireMatch(expected)
    if (current.state !== 'handoff_pending') throw new Error('handoff must be pending before writer transfer')
    if (verification.decision !== 'HANDOFF_ACCEPT') throw new Error('handoff verification must accept before writer transfer')
    if (verification.task_id !== current.task_id || verification.execution_id !== current.execution_id) {
      throw new Error('handoff verification identity does not match writer lease')
    }
    if (!verification.checkpoint_hash || verification.checkpoint_hash.length !== 64) {
      throw new Error('handoff verification must bind a checkpoint hash')
    }
    if (verification.generation !== current.generation + 1) throw new Error('writer transfer must increment generation exactly once')
    const next: WorkspaceWriterLease = {
      ...current,
      executor_id: nextExecutorId,
      generation: verification.generation,
      lease_nonce: randomUUID(),
      state: 'active',
      updated_at: new Date().toISOString()
    }
    await writeAtomic(this.file, next)
    return next
  }

  async assertCanWrite(executorId: string, generation: number): Promise<void> {
    const current = await this.current()
    if (!current || current.state !== 'active' || current.executor_id !== executorId || current.generation !== generation) {
      throw new Error('executor does not hold verified workspace write authority')
    }
  }

  async release(expected: WorkspaceWriterLease): Promise<void> {
    await this.requireMatch(expected)
    await unlink(this.file)
  }

  private async requireMatch(expected: WorkspaceWriterLease): Promise<WorkspaceWriterLease> {
    const current = await this.current()
    if (!current) throw new Error('workspace writer lease is missing')
    if (
      current.task_id !== expected.task_id ||
      current.execution_id !== expected.execution_id ||
      current.workspace !== expected.workspace ||
      current.executor_id !== expected.executor_id ||
      current.generation !== expected.generation ||
      current.lease_nonce !== expected.lease_nonce
    ) {
      throw new Error('workspace writer lease identity changed')
    }
    return current
  }
}
