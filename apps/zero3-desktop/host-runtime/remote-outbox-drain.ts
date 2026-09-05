import type { Zero3RemoteOutboxEnvelope } from './remote-types'

export type Zero3RemotePublishEnvelopeResult = 'published' | 'quarantined'

export async function drainZero3RemoteOutboxInOrder(
  envelopes: Zero3RemoteOutboxEnvelope[],
  publish: (envelope: Zero3RemoteOutboxEnvelope) => Promise<Zero3RemotePublishEnvelopeResult>,
  targetDeliveryId?: string,
  canPublish: (envelope: Zero3RemoteOutboxEnvelope) => boolean = () => true
): Promise<Zero3RemotePublishEnvelopeResult | null> {
  for (const envelope of envelopes) {
    if (!canPublish(envelope)) return null
    const result = await publish(envelope)
    if (targetDeliveryId === envelope.deliveryId) return result
  }
  return null
}
