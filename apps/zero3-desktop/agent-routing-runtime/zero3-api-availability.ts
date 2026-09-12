import fs from 'node:fs/promises'
import path from 'node:path'

import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file'
import type { ExecutorFailureCode } from '../executor-runtime/executor-types'
import type { Zero3ExecutorFailureClass } from './agent-contracts'
import type { Zero3ProviderAvailabilityState, Zero3ProviderAvailabilityStatus } from './agent-router'
import type { Zero3ExecutorTaskClassStats, Zero3RoutingMetricsSnapshot } from './intelligent-router-contracts'

// A Zero3 API profile as the probe needs to see it. Never carries an API key or
// any other secret: the probe only needs to know that a profile exists, which
// protocol it speaks and whether the operator's keystore holds a credential.
export type Zero3ApiProbeProfile = {
  id: string
  name: string
  protocol: 'openai_compatible' | 'anthropic' | 'google_gemini'
  model: string
  baseUrl: string
  hasApiKey: boolean
}

export type Zero3ApiUsageReading = {
  status: 'ready' | 'unavailable' | 'unsupported'
  remainingPercent?: number | null
  detail?: string | null
}

export type Zero3ApiAvailabilityPort = {
  listProfiles(): Promise<readonly Zero3ApiProbeProfile[]>
  // Existing provider-usage service. `unsupported`/`unavailable` is "unknown",
  // never "exhausted": a provider that cannot report a balance must not be
  // silently treated as out of quota.
  usage(profileId: string): Promise<Zero3ApiUsageReading>
  // The single routing-metrics truth source. The probe reads rolling latency
  // from it instead of keeping a second statistics store.
  metrics?(): Promise<Zero3RoutingMetricsSnapshot | null>
}

export type Zero3ApiAvailabilityProbeOptions = {
  port: Zero3ApiAvailabilityPort
  // Operator-pinned profile (ZERO3_API_TASK_PROFILE_ID). Null selects the
  // deterministic default: the most recently updated configured profile.
  profileId?: string | null
  // A provider usage endpoint is a network call: bound it so routing never
  // stalls behind a slow provider.
  usageTimeoutMs?: number
  // Health evidence lifetime. A quota/rate-limit observation outside this window
  // no longer blocks the executor.
  healthTtlMs?: number
  // Optional durable health snapshot so a restart does not forget that the
  // provider answered "quota exhausted" minutes ago.
  stateFile?: string | null
  now?: () => string
  nowMs?: () => number
}

type StoredHealth = {
  profileId: string | null
  status: Zero3ProviderAvailabilityStatus
  detail: string
  observedAtMs: number
}

const DEFAULT_HEALTH_TTL_MS = 15 * 60_000
const DEFAULT_USAGE_TIMEOUT_MS = 5_000
// Profiles whose protocol cannot authenticate without a stored key.
const KEY_REQUIRED_PROTOCOLS = new Set(['anthropic', 'google_gemini'])

export type Zero3ApiProbeResult = Zero3ProviderAvailabilityState & {
  registered: boolean
  online: boolean
  rateLimited: boolean
  quotaExhausted: boolean
  overloaded: boolean
  latencyMs: number | null
  p95LatencyMs: number | null
  profileId: string | null
  profileName: string | null
  profileCount: number
  reason: string
}

function boundedText(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// A degraded provider must not make routing wait: the reading is optional
// evidence, so a deadline falls back to "unknown" rather than failing the probe.
function withTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    work.then(finish, () => finish(fallback))
  })
}

// Provider health reported by the adapter after a real turn. Only routable
// health signals are stored: a policy denial is not a provider condition.
export type Zero3ApiHealthObservation = {
  failureCode: ExecutorFailureCode
  failureClass: Zero3ExecutorFailureClass
  detail: string
  latencyMs?: number | null
}

function healthStatusForCode(code: ExecutorFailureCode): Zero3ProviderAvailabilityStatus | null {
  switch (code) {
    case 'transport_lost': return 'offline'
    case 'auth_required': return 'unauthenticated'
    case 'quota_exhausted': return 'quota_exhausted'
    case 'rate_limited': return 'rate_limited'
    case 'provider_overloaded': return 'overloaded'
    case 'process_crash': return 'offline'
    default: return null
  }
}

// Profile-based Zero3 API availability. The probe answers three separate
// questions instead of one boolean:
//   1. is an API profile registered at all (registered / unregistered),
//   2. can the profile authenticate (authenticated true/false/unknown),
//   3. is the provider actually usable right now (ready / quota_exhausted /
//      rate_limited / overloaded / offline), with observed latency.
export class Zero3Zero3ApiAvailabilityProbe {
  readonly #port: Zero3ApiAvailabilityPort
  readonly #profileId: string | null
  readonly #usageTimeoutMs: number
  readonly #healthTtlMs: number
  readonly #stateFile: string | null
  readonly #now: () => string
  readonly #nowMs: () => number
  #health: StoredHealth | null = null
  #loaded = false
  #observedLatencyMs: number | null = null

  constructor(options: Zero3ApiAvailabilityProbeOptions) {
    this.#port = options.port
    this.#profileId = options.profileId?.trim() || null
    this.#usageTimeoutMs = Number.isSafeInteger(options.usageTimeoutMs) && (options.usageTimeoutMs ?? 0) > 0
      ? options.usageTimeoutMs!
      : DEFAULT_USAGE_TIMEOUT_MS
    this.#healthTtlMs = Number.isSafeInteger(options.healthTtlMs) && (options.healthTtlMs ?? 0) > 0
      ? options.healthTtlMs!
      : DEFAULT_HEALTH_TTL_MS
    this.#stateFile = options.stateFile ?? null
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#nowMs = options.nowMs ?? (() => Date.now())
  }

  // Deterministic profile selection: the operator pin wins, otherwise the most
  // recently updated profile. Recorded on every attempt so the ledger always
  // names the profile that executed the task.
  selectProfile(profiles: readonly Zero3ApiProbeProfile[]): Zero3ApiProbeProfile | null {
    if (this.#profileId) return profiles.find(profile => profile.id === this.#profileId) ?? null
    if (profiles.length === 0) return null
    return [...profiles].sort((a, b) => a.id.localeCompare(b.id))[0]
  }

  async probe(): Promise<Zero3ApiProbeResult> {
    const profiles = await this.#safeProfiles()
    const profile = this.selectProfile(profiles)
    const metrics = await this.#metrics()
    const latency = this.#rollingLatency(metrics)
    const health = await this.#currentHealth()

    const base = {
      registered: profile !== null,
      online: profile !== null,
      rateLimited: false,
      quotaExhausted: false,
      overloaded: false,
      latencyMs: latency.p50,
      p95LatencyMs: latency.p95,
      profileId: profile?.id ?? null,
      profileName: profile?.name ?? null,
      profileCount: profiles.length,
      observedAt: this.#now()
    }

    if (!profile) {
      return {
        ...base,
        available: false,
        authenticated: false,
        status: 'unregistered',
        detail: 'no Zero3 API profile is configured',
        reason: 'no Zero3 API profile is configured'
      }
    }

    const requiresKey = KEY_REQUIRED_PROTOCOLS.has(profile.protocol)
    if (!profile.hasApiKey) {
      // A profile whose protocol cannot authenticate without a key is known
      // unauthenticated. An OpenAI-compatible endpoint may legitimately need no
      // key at all, so that case stays `unknown` instead of being declared
      // broken: the adapter's real turn is what proves it either way.
      if (!requiresKey) {
        return {
          ...base,
          available: true,
          authenticated: null,
          status: 'ready',
          detail: `profile ${profile.name} has no stored API key; the endpoint may accept unauthenticated turns`,
          reason: `Zero3 API profile ${profile.id} selected; authentication is not proven`
        }
      }
      return {
        ...base,
        available: true,
        authenticated: false,
        status: 'unauthenticated',
        detail: `profile ${profile.name} has no API key stored`,
        reason: 'Zero3 API profile has no stored credential'
      }
    }

    // Authenticated locally: the credential exists and was never exposed here.
    const authenticated = true
    if (health) {
      return {
        ...base,
        online: health.status !== 'offline',
        rateLimited: health.status === 'rate_limited',
        quotaExhausted: health.status === 'quota_exhausted',
        overloaded: health.status === 'overloaded',
        available: true,
        authenticated,
        status: health.status,
        detail: health.detail,
        reason: health.detail
      }
    }

    const usage = await this.#safeUsage(profile.id)
    if (usage.status === 'ready' && numberOrNull(usage.remainingPercent) === 0 && requiresKey) {
      const detail = `profile ${profile.name} reported no remaining credit`
      return {
        ...base,
        quotaExhausted: true,
        available: true,
        authenticated,
        status: 'quota_exhausted',
        detail,
        reason: detail
      }
    }

    // Credit is either healthy or unknown; both stay eligible. `unknown` is
    // recorded in detail so an operator can tell "proven ready" from "no quota
    // evidence", without the router treating missing evidence as failure.
    const credit = usage.status === 'ready'
      ? 'credit reported by provider usage'
      : 'credit not reported by provider usage'
    return {
      ...base,
      available: true,
      authenticated,
      status: 'ready',
      detail: `profile ${profile.name} (${profile.protocol}, model ${profile.model}) ready; ${credit}`,
      reason: `Zero3 API profile ${profile.id} selected for execution`
    }
  }

  // Called by the adapter after every real turn so the next routing decision
  // already knows the provider is dry, rate limited, overloaded or offline.
  async noteOutcome(observation: Zero3ApiHealthObservation): Promise<void> {
    const latency = numberOrNull(observation.latencyMs)
    if (latency !== null) this.#observedLatencyMs = latency
    const status = healthStatusForCode(observation.failureCode)
    if (!status) return
    this.#health = {
      profileId: this.#profileId,
      status,
      detail: boundedText(observation.detail) || `latest attempt failed with ${observation.failureCode}`,
      observedAtMs: this.#nowMs()
    }
    await this.#persist()
  }

  async noteSuccess(): Promise<void> {
    if (!this.#health) return
    this.#health = null
    await this.#persist()
  }

  async #safeProfiles(): Promise<readonly Zero3ApiProbeProfile[]> {
    try {
      return await this.#port.listProfiles()
    } catch {
      // A failed registry read is "no profile evidence", not "provider healthy".
      return []
    }
  }

  async #safeUsage(profileId: string): Promise<Zero3ApiUsageReading> {
    try {
      return await withTimeout(
        this.#port.usage(profileId),
        this.#usageTimeoutMs,
        { status: 'unavailable', remainingPercent: null, detail: 'provider usage read timed out' }
      )
    } catch {
      return { status: 'unavailable', remainingPercent: null, detail: 'provider usage is not readable' }
    }
  }

  async #metrics(): Promise<Zero3RoutingMetricsSnapshot | null> {
    if (!this.#port.metrics) return null
    try {
      return await this.#port.metrics()
    } catch {
      return null
    }
  }

  #rollingLatency(metrics: Zero3RoutingMetricsSnapshot | null): { p50: number | null; p95: number | null } {
    let p50: number | null = null
    let p95: number | null = null
    const classes: Partial<Record<string, Zero3ExecutorTaskClassStats>> = metrics?.executors?.['ZERO3_API'] ?? {}
    for (const stats of Object.values(classes)) {
      if (!stats || stats.attempts === 0) continue
      const candidate50 = numberOrNull(stats.p50LatencyMs)
      const candidate95 = numberOrNull(stats.p95LatencyMs)
      if (candidate50 !== null) p50 = p50 === null ? candidate50 : Math.max(p50, candidate50)
      if (candidate95 !== null) p95 = p95 === null ? candidate95 : Math.max(p95, candidate95)
    }
    if (this.#observedLatencyMs !== null) {
      p50 = p50 === null ? this.#observedLatencyMs : Math.max(p50, this.#observedLatencyMs)
    }
    return { p50, p95 }
  }

  async #currentHealth(): Promise<StoredHealth | null> {
    if (!this.#loaded) {
      this.#loaded = true
      await this.#load()
    }
    const health = this.#health
    if (!health) return null
    if (this.#nowMs() - health.observedAtMs > this.#healthTtlMs) {
      this.#health = null
      await this.#persist()
      return null
    }
    return health
  }

  async #load(): Promise<void> {
    if (!this.#stateFile) return
    try {
      const raw = JSON.parse(await fs.readFile(this.#stateFile, 'utf8')) as Partial<StoredHealth>
      const status = raw.status
      if (
        typeof status === 'string' &&
        ['offline', 'unauthenticated', 'rate_limited', 'quota_exhausted', 'overloaded', 'unregistered'].includes(status) &&
        typeof raw.observedAtMs === 'number' &&
        Number.isFinite(raw.observedAtMs)
      ) {
        this.#health = {
          profileId: typeof raw.profileId === 'string' ? raw.profileId : null,
          status: status as Zero3ProviderAvailabilityStatus,
          detail: boundedText(raw.detail) || 'provider health carried over from a previous run',
          observedAtMs: raw.observedAtMs
        }
      }
    } catch {
      // Missing or unreadable health state is unknown, never unhealthy.
    }
  }

  async #persist(): Promise<void> {
    if (!this.#stateFile) return
    try {
      if (!this.#health) {
        await fs.rm(this.#stateFile, { force: true })
        return
      }
      await fs.mkdir(path.dirname(this.#stateFile), { recursive: true })
      await zero3AtomicWriteFile(this.#stateFile, `${JSON.stringify(this.#health, null, 2)}\n`)
    } catch {
      // Health persistence is an optimisation; failing to write it must never
      // change routing.
    }
  }
}
