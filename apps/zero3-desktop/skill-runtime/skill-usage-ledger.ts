import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Zero3SkillUsageRecord } from './skill-types'

const MAX_LEDGER_BYTES = 8 * 1024 * 1024

export class Zero3SkillUsageLedger {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  append(input: Omit<Zero3SkillUsageRecord, 'usageId' | 'at'>): Promise<Zero3SkillUsageRecord> {
    const record: Zero3SkillUsageRecord = {
      ...input,
      usageId: `skill-use-${randomUUID()}`,
      at: new Date().toISOString()
    }
    const task = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const stat = await fs.stat(this.file).catch(() => null)
      if (stat && stat.size >= MAX_LEDGER_BYTES) {
        await fs.rename(this.file, `${this.file}.old`).catch(() => undefined)
      }
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    })
    this.tail = task.then(() => undefined, () => undefined)
    return task.then(() => structuredClone(record))
  }
}
