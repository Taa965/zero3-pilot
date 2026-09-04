import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  DevelopmentDelivery,
  DevelopmentSessionRuntime,
  FailureRecord,
  IntegrationMilestone,
  RepairTask,
  VerificationRun
} from '../contracts/index.ts'
import type { PlanningProposal } from '../planning/index.ts'
import { DevelopmentGroupStore, readDurableJson } from '../store/index.ts'

async function listJsonRecords<T>(directory: string, predicate: (name: string) => boolean = () => true): Promise<T[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files = names.filter(name => name.endsWith('.json') && predicate(name)).sort()
  return Promise.all(files.map(name => readDurableJson<T>(join(directory, name))))
}

export interface DurableGroupRecords {
  runtimes: readonly DevelopmentSessionRuntime[]
  deliveries: readonly DevelopmentDelivery[]
  integrations: readonly IntegrationMilestone[]
  verifications: readonly VerificationRun[]
  failures: readonly FailureRecord[]
  repairs: readonly RepairTask[]
}

export async function loadDurableGroupRecords(store: DevelopmentGroupStore, plan: PlanningProposal): Promise<DurableGroupRecords> {
  const groupDir = store.groupDir(plan.definition.groupId)
  const [runtimes, deliveries, integrations, verifications, failures, repairs] = await Promise.all([
    Promise.all(plan.sessions.map(session => store.loadSession(plan.definition.groupId, session.sessionId))),
    listJsonRecords<DevelopmentDelivery>(join(groupDir, 'deliveries')),
    listJsonRecords<IntegrationMilestone>(join(groupDir, 'integration')),
    listJsonRecords<VerificationRun>(join(groupDir, 'verification')),
    listJsonRecords<FailureRecord>(join(groupDir, 'repair'), name => name.startsWith('failure-')),
    listJsonRecords<RepairTask>(join(groupDir, 'repair'), name => !name.startsWith('failure-'))
  ])
  return {
    runtimes: [...runtimes].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    deliveries: [...deliveries].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    integrations: [...integrations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.integrationRunId.localeCompare(b.integrationRunId)),
    verifications: [...verifications].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.verificationRunId.localeCompare(b.verificationRunId)),
    failures: [...failures].sort((a, b) => a.failureId.localeCompare(b.failureId)),
    repairs: [...repairs].sort((a, b) => a.waveOrdinal - b.waveOrdinal || a.repairTaskId.localeCompare(b.repairTaskId))
  }
}
