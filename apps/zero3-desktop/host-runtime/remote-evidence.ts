import type { Zero3RemoteCodexMapping } from './remote-types'

export type Zero3RemoteEvidenceItem = {
  sequence: number
  method: string
  params: unknown
  at: string
}

export class Zero3RemoteEvidenceCollector {
  private sequence = 0
  private readonly items: Zero3RemoteEvidenceItem[] = []

  constructor(readonly mapping: Zero3RemoteCodexMapping) {}

  push(method: string, params: unknown): Zero3RemoteEvidenceItem {
    const item = {
      sequence: ++this.sequence,
      method,
      params,
      at: new Date().toISOString()
    }
    this.items.push(item)
    return item
  }

  snapshot() {
    return {
      mapping: this.mapping,
      events: [...this.items]
    }
  }
}
