import type { DevelopmentSessionRuntime } from '../contracts/index.ts'
import type { DevelopmentSessionRunner } from '../session/index.ts'

export interface WorkerLaunchResult {
  sessionId: string
  runtime: DevelopmentSessionRuntime
  active: boolean
}

function mayReleaseExecutorBinding(status: DevelopmentSessionRuntime['status']): boolean {
  // OutcomeUnknown deliberately keeps the binding quarantined until an explicit
  // human resolution classifies the uncertain execution. Every authoritative
  // terminal/blocked outcome may release the native Executor session so an
  // allowed retry/start-from-handoff can acquire the same task execution key.
  return status !== 'outcome_unknown' && !['starting', 'running', 'waiting_input'].includes(status)
}

export class DevelopmentGroupWorkerSupervisor {
  readonly #active = new Map<string, Promise<void>>()

  activeSessionIds(): readonly string[] {
    return [...this.#active.keys()].sort()
  }

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId)
  }

  launch(input: {
    runner: DevelopmentSessionRunner
    clientRequestId: string
    afterSettled?: (runtime: DevelopmentSessionRuntime) => Promise<void>
  }): WorkerLaunchResult {
    const sessionId = input.runner.session.sessionId
    if (this.#active.has(sessionId)) throw new Error(`Development Session ${sessionId} already has an active supervised prompt`)
    const before = input.runner.snapshot()
    if (before.status !== 'running') throw new Error(`supervised prompt requires running Session; got ${before.status}`)

    const prompt = input.runner.sendInitialInstruction(input.clientRequestId)
    const job = prompt.then(
      async runtime => {
        try {
          await input.afterSettled?.(runtime)
        } finally {
          if (mayReleaseExecutorBinding(runtime.status)) await input.runner.close()
        }
      },
      async error => {
        const current = input.runner.snapshot()
        if (!['outcome_unknown', 'failed', 'blocked', 'cancelled'].includes(current.status)) {
          await input.runner.markOutcomeUnknown(`supervisor_prompt_exception: ${String(error)}`)
        }
        const settled = input.runner.snapshot()
        if (mayReleaseExecutorBinding(settled.status)) await input.runner.close()
      }
    ).finally(() => {
      if (this.#active.get(sessionId) === job) this.#active.delete(sessionId)
    })
    this.#active.set(sessionId, job)
    return { sessionId, runtime: before, active: true }
  }

  async drain(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.#active.get(sessionId)
      return
    }
    await Promise.all([...this.#active.values()])
  }
}
