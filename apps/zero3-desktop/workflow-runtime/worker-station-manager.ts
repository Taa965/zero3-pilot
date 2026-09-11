import { buildWorkerBootstrapPrompt } from './worker-prompt-registry.ts'

export type WorkerStationRuntimePort = {
  listWorkflowRuns(): Array<Record<string, unknown>>
  workflowSnapshot(workflowRunId: string): Record<string, unknown>
  openPhysicalSession(input: Record<string, unknown>): Record<string, unknown>
  rotatePhysicalSession(input: Record<string, unknown>): Record<string, unknown>
  issueBindingTicket(workerSlotId: string, expiresInSeconds?: number): Record<string, unknown>
}

export type WorkerStationGptPort = {
  create(projectId?: string | null): Promise<{ id: string; conversationUrl?: string | null }>
  sendWakeup(entryId: string, message: string): Promise<{ sent: true }>
  executionStatus(entryId: string): Promise<{ executing: boolean; health: string | null }>
}

export type WorkerStationManagerOptions = {
  intervalMs?: number
}

type SlotSnapshot = {
  binding: Record<string, unknown>
  role: string | null
  promptRevision: string | null
  slot: Record<string, unknown>
  activeSession: Record<string, unknown> | null
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function required(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

function activeClaims(snapshot: Record<string, unknown>, workerSlotId: string): number {
  const claims = Array.isArray(snapshot.claims) ? snapshot.claims : []
  return claims.filter(value => {
    const claim = record(value)
    return claim.workerSlotId === workerSlotId && claim.status === 'ACTIVE'
  }).length
}

export class Zero3WorkerStationManager {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly intervalMs: number

  constructor(
    private readonly runtime: WorkerStationRuntimePort,
    private readonly gpt: WorkerStationGptPort,
    options: WorkerStationManagerOptions = {}
  ) {
    this.intervalMs = Math.max(5_000, Math.min(options.intervalMs ?? 15_000, 120_000))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const runValue of this.runtime.listWorkflowRuns()) {
        const run = record(runValue)
        if (run.status !== 'ACTIVE') continue
        const metadata = record(run.metadata)
        if (metadata.autoProvisionGptWorkers !== true) continue
        const workflowRunId = required(run.workflowRunId, 'workflowRunId')
        const projectId = required(metadata.projectId, 'workflow projectId')
        await this.reconcileRun(workflowRunId, projectId)
      }
    } finally {
      this.ticking = false
    }
  }

  async reconcileRun(workflowRunIdValue: unknown, projectIdValue: unknown): Promise<Record<string, unknown>> {
    const workflowRunId = required(workflowRunIdValue, 'workflowRunId')
    const projectId = required(projectIdValue, 'projectId')
    let snapshot = this.runtime.workflowSnapshot(workflowRunId)
    const results: Record<string, unknown>[] = []
    const slots = Array.isArray(snapshot.slots) ? snapshot.slots : []
    for (const slotValue of slots) {
      const slotSnapshot = record(slotValue) as unknown as SlotSnapshot
      const binding = record(slotSnapshot.binding)
      if (binding.provider !== 'GPT_WEB') continue
      const slot = record(slotSnapshot.slot)
      const workerSlotId = required(slot.workerSlotId, 'workerSlotId')
      const session = slotSnapshot.activeSession ? record(slotSnapshot.activeSession) : null
      try {
        if (session?.state === 'STARTING') {
          const logicalSessionId = required(session.logicalSessionId, 'logicalSessionId')
          const status = await this.gpt.executionStatus(logicalSessionId).catch(() => ({ executing: false, health: null }))
          if (status.executing) {
            results.push({ workerSlotId, state: 'STARTING', action: 'bootstrap_in_progress' })
            continue
          }
          await this.sendBootstrap(workflowRunId, slotSnapshot, logicalSessionId)
          results.push({ workerSlotId, state: 'STARTING', action: 'bootstrap_sent' })
          continue
        }

        const needsRotation = Boolean(session) && (
          slot.state === 'ROTATING' || ['ROTATING', 'LOST', 'CLOSED'].includes(String(session?.state ?? ''))
        )
        if (needsRotation) {
          if (activeClaims(snapshot, workerSlotId) > 0) {
            results.push({ workerSlotId, state: 'ROTATING', action: 'wait_for_claim' })
            continue
          }
          const created = await this.gpt.create(projectId)
          const rotated = record(this.runtime.rotatePhysicalSession({
            workerSlotId,
            logicalSessionId: created.id,
            conversationUrl: created.conversationUrl ?? null,
            reason: 'station_manager_rotation'
          }))
          if (rotated.state !== 'ROTATED') {
            results.push({ workerSlotId, state: rotated.state ?? 'ROTATION_PENDING', action: 'wait_for_rotation' })
            continue
          }
          snapshot = this.runtime.workflowSnapshot(workflowRunId)
          const refreshed = (Array.isArray(snapshot.slots) ? snapshot.slots : [])
            .map(value => record(value) as unknown as SlotSnapshot)
            .find(value => record(value.slot).workerSlotId === workerSlotId)
          if (!refreshed) throw new Error(`rotated worker slot disappeared: ${workerSlotId}`)
          await this.sendBootstrap(workflowRunId, refreshed, created.id)
          results.push({ workerSlotId, state: 'STARTING', action: 'rotated_and_bootstrap_sent', logicalSessionId: created.id })
          continue
        }
        if (!session) {
          const created = await this.gpt.create(projectId)
          const opened = record(this.runtime.openPhysicalSession({
            workerSlotId,
            logicalSessionId: created.id,
            conversationUrl: created.conversationUrl ?? null
          }))
          snapshot = this.runtime.workflowSnapshot(workflowRunId)
          const refreshed = (Array.isArray(snapshot.slots) ? snapshot.slots : [])
            .map(value => record(value) as unknown as SlotSnapshot)
            .find(value => record(value.slot).workerSlotId === workerSlotId)
          if (!refreshed) throw new Error(`opened worker slot disappeared: ${workerSlotId}`)
          await this.sendBootstrap(workflowRunId, refreshed, created.id, String(opened.ticket ?? ''))
          results.push({ workerSlotId, state: 'STARTING', action: 'created_and_bootstrap_sent', logicalSessionId: created.id })
          continue
        }

        results.push({ workerSlotId, state: session.state ?? slot.state ?? 'ACTIVE', action: 'unchanged' })
      } catch (error) {
        results.push({ workerSlotId, state: 'ERROR', action: 'retry_later', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { workflowRunId, projectId, stations: results }
  }

  private async sendBootstrap(
    workflowRunId: string,
    slotSnapshot: SlotSnapshot,
    logicalSessionId: string,
    suppliedTicket?: string
  ): Promise<void> {
    const binding = record(slotSnapshot.binding)
    const slot = record(slotSnapshot.slot)
    const workerSlotId = required(slot.workerSlotId, 'workerSlotId')
    const ticket = suppliedTicket?.trim() || required(record(this.runtime.issueBindingTicket(workerSlotId, 86_400)).ticket, 'bindingTicket')
    const prompt = buildWorkerBootstrapPrompt({
      workflowRunId,
      workerDefinitionId: required(binding.workerDefinitionId, 'workerDefinitionId'),
      workerSlotId,
      role: slotSnapshot.role,
      promptRevision: slotSnapshot.promptRevision,
      bindingTicket: ticket
    })
    await this.gpt.sendWakeup(logicalSessionId, prompt)
  }
}
