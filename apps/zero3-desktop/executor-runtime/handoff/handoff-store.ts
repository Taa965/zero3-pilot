import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

import { verifyCheckpointHash } from './handoff-hash.ts'
import { ZERO3_HANDOFF_SCHEMA, type Zero3HandoffCheckpointV1 } from './handoff-types.ts'

function safePart(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('handoff storage identity contains unsafe characters')
  return value
}

async function syncParentDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(code ?? '')) throw error
  }
}

export class HandoffStore {
  constructor(readonly root: string) {}

  checkpointPath(taskId: string, executionId: string, generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('handoff generation must be positive')
    return path.join(this.root, safePart(taskId), safePart(executionId), `handoff-${generation}.json`)
  }

  async save(checkpoint: Zero3HandoffCheckpointV1): Promise<string> {
    if (!verifyCheckpointHash(checkpoint)) throw new Error('refusing to persist checkpoint with invalid hash')
    const target = this.checkpointPath(checkpoint.task_id, checkpoint.execution_id, checkpoint.handoff_generation)
    const directory = path.dirname(target)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    await syncParentDirectory(directory)
    const finalHandle = await open(target, 'r+')
    try {
      await finalHandle.sync()
    } finally {
      await finalHandle.close()
    }
    return target
  }

  async load(taskId: string, executionId: string, generation: number): Promise<Zero3HandoffCheckpointV1> {
    const target = this.checkpointPath(taskId, executionId, generation)
    const parsed = JSON.parse(await readFile(target, 'utf8')) as Zero3HandoffCheckpointV1
    if (parsed.schema_version !== ZERO3_HANDOFF_SCHEMA) throw new Error('unsupported handoff checkpoint schema')
    if (parsed.task_id !== taskId || parsed.execution_id !== executionId || parsed.handoff_generation !== generation) {
      throw new Error('handoff checkpoint storage identity mismatch')
    }
    if (!verifyCheckpointHash(parsed)) throw new Error('handoff checkpoint hash mismatch')
    return parsed
  }
}
