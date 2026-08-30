import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

import type { AcpSessionMetadata } from './acp-types.ts'

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error('ACP session id contains unsafe storage characters')
  return value
}

export class AcpSessionStore {
  constructor(readonly root: string) {}

  private file(executorId: string, sessionId: string): string {
    return path.join(this.root, safeId(executorId), `${safeId(sessionId)}.json`)
  }

  async save(metadata: AcpSessionMetadata): Promise<void> {
    const file = this.file(metadata.executorId, metadata.sessionId)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  }

  async load(executorId: string, sessionId: string): Promise<AcpSessionMetadata> {
    const parsed = JSON.parse(await readFile(this.file(executorId, sessionId), 'utf8')) as AcpSessionMetadata
    if (
      parsed.schemaVersion !== 'zero3.pilot.acp.session.v1' ||
      parsed.executorId !== executorId ||
      parsed.sessionId !== sessionId ||
      !path.isAbsolute(parsed.workspace)
    ) {
      throw new Error('ACP session metadata identity is invalid')
    }
    return parsed
  }
}
