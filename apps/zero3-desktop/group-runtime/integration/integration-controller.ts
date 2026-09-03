import { createHash } from 'node:crypto'

import type { IntegrationMilestone } from '../contracts/index.ts'
import type { DeliveryGateResult } from '../workspace/index.ts'
import { IntegrationQueue, type IntegrationQueueItem } from './integration-queue.ts'
import type { IntegrationGitPort } from './integration-git.ts'

export interface IntegrationRecordStorePort {
  writeIntegration(record: IntegrationMilestone): Promise<void>
}

export interface DeliveryVerifierPort {
  verify(item: IntegrationQueueItem): Promise<DeliveryGateResult>
}

export interface IntegrationControllerOptions {
  integrationRef: string
  postMergeCheck?: (headSha: string, item: IntegrationQueueItem) => Promise<{ ok: boolean; detail?: string }>
}

function runId(baseSha: string, item: IntegrationQueueItem): string {
  return `I-${createHash('sha256').update(`${baseSha}:${item.session.sessionId}:${item.delivery.deliveryHash}`).digest('hex').slice(0, 16)}`
}

export class IntegrationController {
  readonly integratedSessionIds = new Set<string>()

  constructor(
    readonly queue: IntegrationQueue,
    private readonly git: IntegrationGitPort,
    private readonly verifier: DeliveryVerifierPort,
    private readonly store: IntegrationRecordStorePort,
    readonly options: IntegrationControllerOptions
  ) {}

  async integrateNext(): Promise<IntegrationMilestone | undefined> {
    const item = this.queue.ready(this.integratedSessionIds)[0]
    if (!item) return undefined
    const beforeSha = await this.git.currentHead()
    const integrationRunId = runId(beforeSha, item)
    const reject = async (status: 'conflict' | 'failed', reasons: readonly string[], headSha = beforeSha) => {
      const record: IntegrationMilestone = {
        integrationRunId,
        groupId: item.session.groupId,
        baseSha: beforeSha,
        headSha,
        deliveryHashes: [item.delivery.deliveryHash],
        mergedSessionIds: [],
        status,
        conflicts: [...reasons],
        createdAt: new Date().toISOString()
      }
      await this.store.writeIntegration(record)
      return record
    }

    if ((await this.git.currentBranch()) !== this.options.integrationRef) return reject('failed', ['integration workspace is on the wrong branch'])
    if (!(await this.git.statusClean())) return reject('failed', ['integration workspace is dirty before merge'])
    if ((await this.git.branchHead(item.session.branch)) !== item.delivery.headSha) return reject('failed', ['worker branch head does not match Delivery head'])

    const deliveryGate = await this.verifier.verify(item)
    if (deliveryGate.decision !== 'DELIVERY_ACCEPT') return reject('failed', deliveryGate.reasons.map(reason => `delivery: ${reason}`))

    const merge = await this.git.merge(item.session.branch)
    if (merge.status === 'conflict') return reject('conflict', [merge.detail ?? 'Git merge conflict'], merge.headSha)

    if (this.options.postMergeCheck) {
      const check = await this.options.postMergeCheck(merge.headSha, item)
      if (!check.ok) {
        await this.git.resetTo(beforeSha)
        return reject('failed', [`post-merge check failed: ${check.detail ?? 'unknown'}`], beforeSha)
      }
    }

    const record: IntegrationMilestone = {
      integrationRunId,
      groupId: item.session.groupId,
      baseSha: beforeSha,
      headSha: merge.headSha,
      deliveryHashes: [item.delivery.deliveryHash],
      mergedSessionIds: [item.session.sessionId],
      status: 'merged',
      conflicts: [],
      createdAt: new Date().toISOString()
    }
    await this.store.writeIntegration(record)
    this.integratedSessionIds.add(item.session.sessionId)
    this.queue.remove(item.session.sessionId)
    return record
  }

  async drainUntilBlocked(): Promise<readonly IntegrationMilestone[]> {
    const records: IntegrationMilestone[] = []
    while (true) {
      const record = await this.integrateNext()
      if (!record) return records
      records.push(record)
      if (record.status !== 'merged') return records
    }
  }
}
