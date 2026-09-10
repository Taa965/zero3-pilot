import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DurableStoreCorruptionError,
  readDurableJson,
  recoverInterruptedWrite,
  stableJson,
  writeDurableJson
} from '../group-runtime/store/atomic-file.ts'
import type { ExecutionEvent, ExecutionRuntimeState, ExecutionWorkflowDefinition } from './contracts.ts'
import { appendExecutionEvent, readExecutionEventLedger } from './event-ledger.ts'
import { validateExecutionWorkflowDefinition } from './validators.ts'

interface DurableExecutionSnapshot {
  definition: ExecutionWorkflowDefinition
  runtime: ExecutionRuntimeState
}

export interface ExecutionStoreReconcileResult {
  taskId: string
  eventCount: number
  stateEventSequence: number
  needsSemanticReplay: boolean
  recoveredFiles: readonly string[]
}

function safeId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) throw new Error(`${label} is not a safe path segment`)
  return normalized
}

function assertDefinition(definition: ExecutionWorkflowDefinition): void {
  const errors = validateExecutionWorkflowDefinition(definition)
  if (errors.length > 0) throw new Error(`invalid execution workflow: ${errors.join('; ')}`)
}

function assertRuntime(definition: ExecutionWorkflowDefinition, runtime: ExecutionRuntimeState): void {
  const taskId = definition.task.taskId
  if (runtime.task.taskId !== taskId) throw new Error('execution runtime task identity mismatch')
  const stepIds = new Set(definition.steps.map(step => step.stepId))
  if (runtime.steps.length !== stepIds.size) throw new Error('execution runtime step count mismatch')
  if (runtime.steps.some(step => step.taskId !== taskId || !stepIds.has(step.stepId))) throw new Error('execution runtime contains unknown step')
  if (new Set(runtime.steps.map(step => step.stepId)).size !== runtime.steps.length) throw new Error('execution runtime contains duplicate step state')
  const assignmentIds = new Set<string>()
  for (const assignment of runtime.assignments) {
    if (assignment.taskId !== taskId || !stepIds.has(assignment.stepId)) throw new Error('execution assignment identity mismatch')
    if (assignmentIds.has(assignment.assignmentId)) throw new Error('duplicate execution assignment id')
    assignmentIds.add(assignment.assignmentId)
  }
  const bindingIds = new Set<string>()
  for (const binding of runtime.sessionBindings) {
    if (binding.taskId !== taskId || !stepIds.has(binding.stepId) || !assignmentIds.has(binding.assignmentId)) throw new Error('execution session binding identity mismatch')
    if (bindingIds.has(binding.bindingId)) throw new Error('duplicate execution session binding id')
    bindingIds.add(binding.bindingId)
  }
}

function assertSnapshot(snapshot: DurableExecutionSnapshot): void {
  assertDefinition(snapshot.definition)
  assertRuntime(snapshot.definition, snapshot.runtime)
}

export class Zero3ExecutionStore {
  constructor(readonly rootDir: string) {}

  taskDir(taskId: string): string {
    return join(this.rootDir, safeId(taskId, 'taskId'))
  }

  private path(taskId: string, relative: string): string {
    return join(this.taskDir(taskId), relative)
  }

  private async loadSnapshotRecord(taskId: string): Promise<DurableExecutionSnapshot> {
    const snapshot = await readDurableJson<DurableExecutionSnapshot>(this.path(taskId, 'snapshot.json'))
    assertSnapshot(snapshot)
    if (snapshot.definition.task.taskId !== taskId) throw new DurableStoreCorruptionError(`Execution Task ${taskId} snapshot identity mismatch`)
    return snapshot
  }

  async initialize(definition: ExecutionWorkflowDefinition, runtime: ExecutionRuntimeState): Promise<void> {
    const snapshot = { definition, runtime }
    assertSnapshot(snapshot)
    await mkdir(this.rootDir, { recursive: true })
    await mkdir(this.taskDir(definition.task.taskId), { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error(`Execution Task already exists: ${definition.task.taskId}`)
      throw error
    })
    await writeDurableJson(this.path(definition.task.taskId, 'snapshot.json'), snapshot)
  }

  async loadDefinition(taskId: string): Promise<ExecutionWorkflowDefinition> {
    return (await this.loadSnapshotRecord(taskId)).definition
  }

  async loadRuntime(taskId: string): Promise<ExecutionRuntimeState> {
    return (await this.loadSnapshotRecord(taskId)).runtime
  }

  async loadSnapshot(taskId: string): Promise<DurableExecutionSnapshot> {
    return this.loadSnapshotRecord(taskId)
  }

  async writeSnapshot(definition: ExecutionWorkflowDefinition, runtime: ExecutionRuntimeState): Promise<void> {
    const snapshot = { definition, runtime }
    assertSnapshot(snapshot)
    const current = await this.loadSnapshotRecord(definition.task.taskId)
    if (definition.revision < current.definition.revision) throw new Error('workflow revision cannot move backwards')
    if (definition.revision === current.definition.revision && stableJson(definition) !== stableJson(current.definition)) {
      throw new Error('workflow definition changed without revision increment')
    }
    await writeDurableJson(this.path(definition.task.taskId, 'snapshot.json'), snapshot)
  }

  async writeDefinition(definition: ExecutionWorkflowDefinition): Promise<void> {
    const current = await this.loadSnapshotRecord(definition.task.taskId)
    if (definition.revision <= current.definition.revision) throw new Error('workflow revision must increase')
    await this.writeSnapshot(definition, current.runtime)
  }

  async writeRuntime(runtime: ExecutionRuntimeState): Promise<void> {
    const current = await this.loadSnapshotRecord(runtime.task.taskId)
    await this.writeSnapshot(current.definition, runtime)
  }

  appendEvent(event: ExecutionEvent): Promise<'appended' | 'duplicate'> {
    return appendExecutionEvent(this.path(event.taskId, 'events.jsonl'), event)
  }

  readEvents(taskId: string): Promise<ExecutionEvent[]> {
    return readExecutionEventLedger(this.path(taskId, 'events.jsonl'))
  }

  async listTaskIds(): Promise<string[]> {
    let entries
    try { entries = await readdir(this.rootDir, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  }

  async reconcile(taskId: string): Promise<ExecutionStoreReconcileResult> {
    const recoveredFiles: string[] = []
    const recovered = await recoverInterruptedWrite(this.path(taskId, 'snapshot.json'))
    if (recovered === 'recovered') recoveredFiles.push('snapshot.json')
    const [snapshot, events] = await Promise.all([this.loadSnapshotRecord(taskId), this.readEvents(taskId)])
    if (snapshot.runtime.task.lastEventSequence > events.length) {
      throw new DurableStoreCorruptionError(`runtime sequence ${snapshot.runtime.task.lastEventSequence} is ahead of event ledger ${events.length}`)
    }
    return {
      taskId,
      eventCount: events.length,
      stateEventSequence: snapshot.runtime.task.lastEventSequence,
      needsSemanticReplay: snapshot.runtime.task.lastEventSequence < events.length,
      recoveredFiles
    }
  }
}
