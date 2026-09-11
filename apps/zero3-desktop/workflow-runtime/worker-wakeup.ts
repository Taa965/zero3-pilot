export type WorkflowWorkerWakeup = {
  wakeupId: string
  workflowRunId: string
  workerDefinitionId: string
  workerSlotId: string
  workerSessionId: string
  logicalSessionId: string
  queueGeneration: number
  attemptCount: number
  message: string
}

export type WorkerWakeupRuntimePort = {
  pendingWakeups(limit?: number): Array<Record<string, unknown>>
  markWakeupDelivered(wakeupId: string): void
  deferWakeup(wakeupId: string, reason: string): void
  suppressWakeup(wakeupId: string, reason: string): void
  requireRotationForWakeup(wakeupId: string, reason: string): void
}

export type GptWebWakeupPort = {
  executionStatus(entryId: string): Promise<{
    executing: boolean
    health: 'active' | 'idle' | 'stalled' | 'timeout_error' | 'recovering' | 'recovery_failed' | null
  }>
  sendWakeup(entryId: string, message: string): Promise<{ sent: true }>
}

export type WorkerWakeupControllerOptions = {
  intervalMs?: number
  batchSize?: number
  stalledAttemptsBeforeRotate?: number
}
function wakeup(value: Record<string, unknown>): WorkflowWorkerWakeup {
  const required = (key: keyof WorkflowWorkerWakeup): string => {
    const text = typeof value[key] === 'string' ? String(value[key]).trim() : ''
    if (!text) throw new Error(`invalid worker wakeup ${String(key)}`)
    return text
  }
  const queueGeneration = Number(value.queueGeneration)
  const attemptCount = Number(value.attemptCount)
  if (!Number.isSafeInteger(queueGeneration) || queueGeneration < 1) throw new Error('invalid worker wakeup queueGeneration')
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error('invalid worker wakeup attemptCount')
  return {
    wakeupId: required('wakeupId'),
    workflowRunId: required('workflowRunId'),
    workerDefinitionId: required('workerDefinitionId'),
    workerSlotId: required('workerSlotId'),
    workerSessionId: required('workerSessionId'),
    logicalSessionId: required('logicalSessionId'),
    queueGeneration,
    attemptCount,
    message: required('message')
  }
}

export class Zero3WorkerWakeupController {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly stalledAttemptsBeforeRotate: number
  constructor(
    private readonly runtime: WorkerWakeupRuntimePort,
    private readonly gpt: GptWebWakeupPort,
    options: WorkerWakeupControllerOptions = {}
  ) {
    this.intervalMs = Math.max(1000, Math.min(options.intervalMs ?? 5000, 60_000))
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 20, 100))
    this.stalledAttemptsBeforeRotate = Math.max(1, Math.min(options.stalledAttemptsBeforeRotate ?? 3, 20))
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
    if (this.inFlight) return
    this.inFlight = true
    try {
      for (const raw of this.runtime.pendingWakeups(this.batchSize)) {
        await this.deliver(wakeup(raw))
      }
    } finally {
      this.inFlight = false
    }
  }

  private async deliver(item: WorkflowWorkerWakeup): Promise<void> {
    let status: Awaited<ReturnType<GptWebWakeupPort['executionStatus']>>
    try {
      status = await this.gpt.executionStatus(item.logicalSessionId)
    } catch (error) {
      this.runtime.deferWakeup(item.wakeupId, `execution status unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (status.executing) {
      if (status.health === 'stalled' && item.attemptCount >= this.stalledAttemptsBeforeRotate) {
        this.runtime.requireRotationForWakeup(item.wakeupId, 'GPT Web execution is stalled; physical session rotation required')
      } else {
        this.runtime.deferWakeup(item.wakeupId, `GPT Web session is executing (${status.health ?? 'active'})`)
      }
      return
    }
    if (status.health === 'timeout_error' || status.health === 'recovering') {
      this.runtime.deferWakeup(item.wakeupId, `GPT Web session recovery is in progress (${status.health})`)
      return
    }
    if (status.health === 'recovery_failed') {
      if (item.attemptCount >= this.stalledAttemptsBeforeRotate) {
        this.runtime.requireRotationForWakeup(item.wakeupId, 'GPT Web timeout recovery failed; physical session rotation required')
      } else {
        this.runtime.deferWakeup(item.wakeupId, 'GPT Web timeout recovery failed; waiting before physical session rotation')
      }
      return
    }
    try {
      await this.gpt.sendWakeup(item.logicalSessionId, item.message)
      this.runtime.markWakeupDelivered(item.wakeupId)
    } catch (error) {
      this.runtime.deferWakeup(item.wakeupId, `GPT Web wakeup delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
