import type {
  DevelopmentGroupPolicy,
  DevelopmentSessionDefinition,
  DevelopmentSessionRuntime,
  DevelopmentWave
} from '../contracts/index.ts'
import { sessionReadiness, validateSchedulerDag, type WaveGateEvidence } from './dag.ts'

export interface ScheduleSnapshot {
  readySessionIds: readonly string[]
  availableSlots: number
  paused: boolean
  cancelled: boolean
  repairWavesUsed: number
}

export class DevelopmentSchedulerError extends Error {}

export class DevelopmentSessionScheduler {
  readonly #sessionsById: Map<string, DevelopmentSessionDefinition>
  readonly #wavesById: Map<string, DevelopmentWave>
  readonly #readySince = new Map<string, number>()
  readonly #pausedSessions = new Set<string>()
  readonly #explicitRetries = new Set<string>()
  #sequence = 0
  #paused = false
  #cancelled = false
  #repairWavesUsed = 0

  constructor(
    readonly policy: DevelopmentGroupPolicy,
    sessions: readonly DevelopmentSessionDefinition[],
    waves: readonly DevelopmentWave[]
  ) {
    const dagErrors = validateSchedulerDag(sessions, waves)
    if (dagErrors.length > 0) throw new DevelopmentSchedulerError(`invalid scheduler DAG: ${dagErrors.join('; ')}`)
    this.#sessionsById = new Map(sessions.map(session => [session.sessionId, session] as const))
    this.#wavesById = new Map(waves.map(wave => [wave.waveId, wave] as const))
  }

  pauseGroup(): void { this.#paused = true }
  resumeGroup(): void {
    if (this.#cancelled) throw new DevelopmentSchedulerError('cancelled scheduler cannot resume')
    this.#paused = false
  }
  cancelGroup(): void {
    this.#cancelled = true
    this.#paused = true
    this.#readySince.clear()
    this.#explicitRetries.clear()
  }
  pauseSession(sessionId: string): void {
    this.requireSession(sessionId)
    this.#pausedSessions.add(sessionId)
    this.#readySince.delete(sessionId)
  }
  resumeSession(sessionId: string): void {
    this.requireSession(sessionId)
    this.#pausedSessions.delete(sessionId)
  }

  requestRetry(runtime: DevelopmentSessionRuntime): void {
    this.requireSession(runtime.sessionId)
    if (runtime.status === 'outcome_unknown') throw new DevelopmentSchedulerError('OutcomeUnknown cannot enter automatic retry')
    if (runtime.status !== 'failed' && runtime.status !== 'blocked') throw new DevelopmentSchedulerError(`only failed/blocked sessions may request retry; got ${runtime.status}`)
    if (runtime.attempt >= this.policy.maxSessionAttempts) throw new DevelopmentSchedulerError('session attempt budget exhausted')
    this.#explicitRetries.add(runtime.sessionId)
  }

  consumeRetry(sessionId: string): void {
    this.#explicitRetries.delete(sessionId)
  }

  registerRepairWave(): number {
    if (this.#repairWavesUsed >= this.policy.maxRepairWaves) throw new DevelopmentSchedulerError('repair wave budget exhausted')
    this.#repairWavesUsed += 1
    return this.#repairWavesUsed
  }

  snapshot(input: {
    runtimes: readonly DevelopmentSessionRuntime[]
    waveEvidence: ReadonlyMap<string, WaveGateEvidence>
    runningSessionCount: number
  }): ScheduleSnapshot {
    if (!Number.isSafeInteger(input.runningSessionCount) || input.runningSessionCount < 0) {
      throw new DevelopmentSchedulerError('runningSessionCount must be a non-negative safe integer')
    }
    const availableSlots = Math.max(0, this.policy.maxParallelSessions - input.runningSessionCount)
    if (this.#paused || this.#cancelled || availableSlots === 0) {
      return { readySessionIds: [], availableSlots, paused: this.#paused, cancelled: this.#cancelled, repairWavesUsed: this.#repairWavesUsed }
    }

    const runtimeById = new Map(input.runtimes.map(runtime => [runtime.sessionId, runtime] as const))
    const candidates: Array<{ sessionId: string; waveOrdinal: number; readySince: number }> = []

    for (const [sessionId, session] of this.#sessionsById) {
      const runtime = runtimeById.get(sessionId)
      if (!runtime || this.#pausedSessions.has(sessionId)) {
        this.#readySince.delete(sessionId)
        continue
      }
      if (runtime.status === 'outcome_unknown' || ['starting', 'running', 'waiting_input', 'delivering', 'delivered', 'integrating', 'integrated', 'verified', 'cancelled', 'superseded'].includes(runtime.status)) {
        this.#readySince.delete(sessionId)
        continue
      }
      if (runtime.attempt >= this.policy.maxSessionAttempts && runtime.status !== 'planned' && runtime.status !== 'waiting_dependencies' && runtime.status !== 'ready') {
        this.#readySince.delete(sessionId)
        continue
      }

      const wave = this.#wavesById.get(session.waveId)
      if (!wave) throw new DevelopmentSchedulerError(`session ${sessionId} references missing wave ${session.waveId}`)
      const retryAllowed = this.#explicitRetries.has(sessionId)
      const schedulableRuntime = retryAllowed && ['failed', 'blocked'].includes(runtime.status)
        ? { ...runtime, status: 'ready' as const }
        : runtime
      const readiness = sessionReadiness({ session, runtime: schedulableRuntime, runtimes: input.runtimes, wave, waveEvidence: input.waveEvidence })
      if (!readiness.ready) {
        this.#readySince.delete(sessionId)
        continue
      }
      if (!this.#readySince.has(sessionId)) this.#readySince.set(sessionId, ++this.#sequence)
      candidates.push({ sessionId, waveOrdinal: wave.ordinal, readySince: this.#readySince.get(sessionId)! })
    }

    candidates.sort((left, right) => left.waveOrdinal - right.waveOrdinal || left.readySince - right.readySince || left.sessionId.localeCompare(right.sessionId))
    return {
      readySessionIds: candidates.slice(0, availableSlots).map(candidate => candidate.sessionId),
      availableSlots,
      paused: false,
      cancelled: false,
      repairWavesUsed: this.#repairWavesUsed
    }
  }

  private requireSession(sessionId: string): DevelopmentSessionDefinition {
    const session = this.#sessionsById.get(sessionId)
    if (!session) throw new DevelopmentSchedulerError(`unknown Development Session ${sessionId}`)
    return session
  }
}
