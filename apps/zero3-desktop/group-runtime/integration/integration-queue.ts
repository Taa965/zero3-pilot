import type { DevelopmentDelivery, DevelopmentSessionDefinition, DevelopmentWave } from '../contracts/index.ts'

export interface IntegrationQueueItem {
  session: DevelopmentSessionDefinition
  delivery: DevelopmentDelivery
  waveOrdinal: number
  enqueuedSequence: number
}

export class IntegrationQueue {
  #sequence = 0
  #items = new Map<string, IntegrationQueueItem>()

  enqueue(session: DevelopmentSessionDefinition, delivery: DevelopmentDelivery, waves: readonly DevelopmentWave[]): void {
    if (session.sessionId !== delivery.sessionId || session.executionId !== delivery.executionId) throw new Error('integration queue identity mismatch')
    const wave = waves.find(candidate => candidate.waveId === session.waveId)
    if (!wave) throw new Error(`unknown wave ${session.waveId}`)
    const existing = this.#items.get(session.sessionId)
    if (existing && existing.delivery.deliveryHash !== delivery.deliveryHash) throw new Error(`session ${session.sessionId} already queued with another Delivery`)
    if (!existing) this.#items.set(session.sessionId, { session, delivery, waveOrdinal: wave.ordinal, enqueuedSequence: ++this.#sequence })
  }

  remove(sessionId: string): void { this.#items.delete(sessionId) }

  ready(integratedSessionIds: ReadonlySet<string>): readonly IntegrationQueueItem[] {
    return [...this.#items.values()]
      .filter(item => item.session.dependencies.every(dependency => integratedSessionIds.has(dependency)))
      .sort((left, right) => left.waveOrdinal - right.waveOrdinal || left.enqueuedSequence - right.enqueuedSequence || left.session.sessionId.localeCompare(right.session.sessionId))
  }

  snapshot(): readonly IntegrationQueueItem[] {
    return [...this.#items.values()].sort((left, right) => left.enqueuedSequence - right.enqueuedSequence)
  }
}
