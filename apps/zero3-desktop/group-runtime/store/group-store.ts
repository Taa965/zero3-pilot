import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  DevelopmentDelivery,
  DevelopmentGroupDefinition,
  DevelopmentGroupRuntimeState,
  DevelopmentRequirement,
  DevelopmentSessionRuntime,
  FailureRecord,
  GroupEvent,
  IntegrationMilestone,
  RepairTask,
  VerificationRun
} from '../contracts/index.ts'
import { readDurableJson, recoverInterruptedWrite, writeDurableJson, DurableStoreCorruptionError } from './atomic-file.ts'
import { appendGroupEvent, readEventLedger } from './event-ledger.ts'

export interface GroupReconcileResult {
  groupId: string
  eventCount: number
  stateEventSequence: number
  needsSemanticReplay: boolean
  recoveredFiles: readonly string[]
}

function assertSafeId(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) {
    throw new Error(`${name} is not a safe path segment`)
  }
  return normalized
}

export class DevelopmentGroupStore {
  constructor(readonly rootDir: string) {}

  groupDir(groupId: string): string {
    return join(this.rootDir, assertSafeId(groupId, 'groupId'))
  }

  private path(groupId: string, relative: string): string {
    return join(this.groupDir(groupId), relative)
  }

  async initialize(
    definition: DevelopmentGroupDefinition,
    state: DevelopmentGroupRuntimeState,
    requirements: readonly DevelopmentRequirement[]
  ): Promise<void> {
    if (definition.groupId !== state.groupId || requirements.some(requirement => requirement.groupId !== definition.groupId)) {
      throw new Error('group initialization identity mismatch')
    }
    const directory = this.groupDir(definition.groupId)
    await mkdir(directory, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error(`Development Group already exists: ${definition.groupId}`)
      throw error
    })
    await Promise.all([
      writeDurableJson(this.path(definition.groupId, 'definition.json'), definition),
      writeDurableJson(this.path(definition.groupId, 'state.json'), state),
      writeDurableJson(this.path(definition.groupId, 'requirements.json'), requirements),
      mkdir(this.path(definition.groupId, 'sessions'), { recursive: true }),
      mkdir(this.path(definition.groupId, 'deliveries'), { recursive: true }),
      mkdir(this.path(definition.groupId, 'integration'), { recursive: true }),
      mkdir(this.path(definition.groupId, 'verification'), { recursive: true }),
      mkdir(this.path(definition.groupId, 'repair'), { recursive: true })
    ])
  }

  loadDefinition(groupId: string): Promise<DevelopmentGroupDefinition> {
    return readDurableJson(this.path(groupId, 'definition.json'))
  }

  loadState(groupId: string): Promise<DevelopmentGroupRuntimeState> {
    return readDurableJson(this.path(groupId, 'state.json'))
  }

  loadRequirements(groupId: string): Promise<DevelopmentRequirement[]> {
    return readDurableJson(this.path(groupId, 'requirements.json'))
  }

  writeState(state: DevelopmentGroupRuntimeState): Promise<void> {
    return writeDurableJson(this.path(state.groupId, 'state.json'), state)
  }

  writeRequirements(groupId: string, requirements: readonly DevelopmentRequirement[]): Promise<void> {
    if (requirements.some(requirement => requirement.groupId !== groupId)) throw new Error('requirement group mismatch')
    return writeDurableJson(this.path(groupId, 'requirements.json'), requirements)
  }

  writeSession(runtime: DevelopmentSessionRuntime): Promise<void> {
    return writeDurableJson(this.path(runtime.groupId, `sessions/${assertSafeId(runtime.sessionId, 'sessionId')}.json`), runtime)
  }

  loadSession(groupId: string, sessionId: string): Promise<DevelopmentSessionRuntime> {
    return readDurableJson(this.path(groupId, `sessions/${assertSafeId(sessionId, 'sessionId')}.json`))
  }

  writeDelivery(delivery: DevelopmentDelivery): Promise<void> {
    return writeDurableJson(this.path(delivery.groupId, `deliveries/${assertSafeId(delivery.sessionId, 'sessionId')}.json`), delivery)
  }

  loadDelivery(groupId: string, sessionId: string): Promise<DevelopmentDelivery> {
    return readDurableJson(this.path(groupId, `deliveries/${assertSafeId(sessionId, 'sessionId')}.json`))
  }

  writeIntegration(record: IntegrationMilestone): Promise<void> {
    return writeDurableJson(this.path(record.groupId, `integration/${assertSafeId(record.integrationRunId, 'integrationRunId')}.json`), record)
  }

  writeVerification(record: VerificationRun): Promise<void> {
    return writeDurableJson(this.path(record.groupId, `verification/${assertSafeId(record.verificationRunId, 'verificationRunId')}.json`), record)
  }

  writeFailure(record: FailureRecord): Promise<void> {
    return writeDurableJson(this.path(record.groupId, `repair/failure-${assertSafeId(record.failureId, 'failureId')}.json`), record)
  }

  writeRepair(record: RepairTask): Promise<void> {
    return writeDurableJson(this.path(record.groupId, `repair/${assertSafeId(record.repairTaskId, 'repairTaskId')}.json`), record)
  }

  appendEvent(event: GroupEvent): Promise<'appended' | 'duplicate'> {
    return appendGroupEvent(this.path(event.groupId, 'events.jsonl'), event)
  }

  readEvents(groupId: string): Promise<GroupEvent[]> {
    return readEventLedger(this.path(groupId, 'events.jsonl'))
  }

  async listGroupIds(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  }

  async reconcile(groupId: string): Promise<GroupReconcileResult> {
    const recoveredFiles: string[] = []
    for (const relative of ['definition.json', 'state.json', 'requirements.json']) {
      const result = await recoverInterruptedWrite(this.path(groupId, relative))
      if (result === 'recovered') recoveredFiles.push(relative)
    }
    const [definition, state, requirements, events] = await Promise.all([
      this.loadDefinition(groupId),
      this.loadState(groupId),
      this.loadRequirements(groupId),
      this.readEvents(groupId)
    ])
    if (definition.groupId !== groupId || state.groupId !== groupId || requirements.some(requirement => requirement.groupId !== groupId)) {
      throw new DurableStoreCorruptionError(`Development Group ${groupId} contains cross-group durable records`)
    }
    if (state.lastEventSequence > events.length) {
      throw new DurableStoreCorruptionError(`state sequence ${state.lastEventSequence} is ahead of durable ledger ${events.length}`)
    }
    return {
      groupId,
      eventCount: events.length,
      stateEventSequence: state.lastEventSequence,
      needsSemanticReplay: state.lastEventSequence < events.length,
      recoveredFiles
    }
  }
}
