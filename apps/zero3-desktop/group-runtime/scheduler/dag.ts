import type {
  DevelopmentSessionDefinition,
  DevelopmentSessionRuntime,
  DevelopmentWave
} from '../contracts/index.ts'

export interface WaveGateEvidence {
  waveId: string
  integrationValid: boolean
  requiredDeliveriesValid: boolean
  ownershipValid: boolean
}

export interface SessionReadiness {
  sessionId: string
  ready: boolean
  reasons: readonly string[]
}

const DEPENDENCY_SATISFIED = new Set<DevelopmentSessionRuntime['status']>([
  'delivered',
  'integrating',
  'integrated',
  'verified'
])

function byId<T extends { sessionId: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map(value => [value.sessionId, value] as const))
}

export function validateSchedulerDag(
  sessions: readonly DevelopmentSessionDefinition[],
  waves: readonly DevelopmentWave[]
): readonly string[] {
  const errors: string[] = []
  const sessionsById = byId(sessions)
  const waveById = new Map(waves.map(wave => [wave.waveId, wave] as const))
  for (const session of sessions) {
    for (const dependency of session.dependencies) {
      const dependencySession = sessionsById.get(dependency)
      if (!dependencySession) errors.push(`${session.sessionId} depends on unknown session ${dependency}`)
      else if (dependencySession.waveId === session.waveId) {
        // Same-wave dependencies serialize workers and violate the intended parallel-wave model.
        errors.push(`${session.sessionId} has same-wave implementation dependency on ${dependency}`)
      }
    }
  }
  for (const wave of waves) {
    for (const dependency of wave.dependsOnWaveIds) {
      if (!waveById.has(dependency)) errors.push(`${wave.waveId} depends on unknown wave ${dependency}`)
      const target = waveById.get(dependency)
      if (target && target.ordinal >= wave.ordinal) errors.push(`${wave.waveId} depends on non-earlier wave ${dependency}`)
    }
  }
  return errors.sort()
}

export function waveGateOpen(
  wave: DevelopmentWave,
  evidenceByWave: ReadonlyMap<string, WaveGateEvidence>
): boolean {
  return wave.dependsOnWaveIds.every(dependencyId => {
    const evidence = evidenceByWave.get(dependencyId)
    return evidence?.integrationValid === true && evidence.requiredDeliveriesValid === true && evidence.ownershipValid === true
  })
}

export function sessionReadiness(input: {
  session: DevelopmentSessionDefinition
  runtime: DevelopmentSessionRuntime
  runtimes: readonly DevelopmentSessionRuntime[]
  wave: DevelopmentWave
  waveEvidence: ReadonlyMap<string, WaveGateEvidence>
}): SessionReadiness {
  const reasons: string[] = []
  const runtimeById = byId(input.runtimes)
  if (!['planned', 'waiting_dependencies', 'ready', 'failed'].includes(input.runtime.status)) {
    reasons.push(`status ${input.runtime.status} is not schedulable`)
  }
  if (!waveGateOpen(input.wave, input.waveEvidence)) reasons.push(`wave gate ${input.wave.waveId} is closed`)
  for (const dependencyId of input.session.dependencies) {
    const dependencyRuntime = runtimeById.get(dependencyId)
    if (!dependencyRuntime) reasons.push(`dependency runtime ${dependencyId} is missing`)
    else if (!DEPENDENCY_SATISFIED.has(dependencyRuntime.status)) reasons.push(`dependency ${dependencyId} is ${dependencyRuntime.status}`)
  }
  if (input.runtime.status === 'failed') reasons.push('failed session requires explicit retry budget decision')
  if (input.runtime.status === 'outcome_unknown') reasons.push('OutcomeUnknown cannot be automatically scheduled')
  return { sessionId: input.session.sessionId, ready: reasons.length === 0, reasons }
}
