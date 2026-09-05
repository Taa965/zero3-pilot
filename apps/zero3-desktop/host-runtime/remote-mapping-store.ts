import fs from 'node:fs/promises'
import path from 'node:path'

import type { Zero3RemoteCodexMapping } from './remote-types'

type MappingFile = {
  schemaVersion: 1
  mappings: Record<string, Zero3RemoteCodexMapping>
}

function emptyFile(): MappingFile {
  return { schemaVersion: 1, mappings: {} }
}

export class Zero3RemoteMappingStore {
  constructor(private readonly file: string) {}

  async get(taskId: string): Promise<Zero3RemoteCodexMapping | null> {
    const state = await this.read()
    return state.mappings[taskId] ?? null
  }

  async put(mapping: Zero3RemoteCodexMapping): Promise<void> {
    const state = await this.read()
    state.mappings[mapping.taskId] = {
      ...mapping,
      turnIds: [...mapping.turnIds]
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}`
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.file)
  }

  private async read(): Promise<MappingFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<MappingFile>
      if (parsed.schemaVersion !== 1 || !parsed.mappings || typeof parsed.mappings !== 'object') {
        throw new Error('invalid Zero3 Remote Host mapping state')
      }
      return { schemaVersion: 1, mappings: parsed.mappings }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw error
    }
  }
}
