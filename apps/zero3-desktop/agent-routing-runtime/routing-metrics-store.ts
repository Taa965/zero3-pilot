import fs from 'node:fs/promises'
import path from 'node:path'
import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file'

import type {
  Zero3ExecutorTaskClassStats,
  Zero3RoutingMetricsSnapshot
} from './intelligent-router-contracts'

const METRICS_PROTOCOL = 'zero3.pilot.routing-metrics.v1'
const DEFAULT_MAX_SAMPLES = 200

type StoredSample = {
  at: number
  succeeded: boolean
  verificationPassed: boolean | null
  latencyMs: number | null
  costUsd: number | null
  failover: boolean
}

type StoredKey = { samples: StoredSample[] }

type StoredState = {
  protocol: typeof METRICS_PROTOCOL
  version: 1
  updatedAt: string
  keys: Record<string, StoredKey>
}

export type Zero3RoutingOutcomeInput = {
  executorId: string
  taskClass: string
  succeeded: boolean
  verificationPassed?: boolean | null
  latencyMs?: number | null
  costUsd?: number | null
  // True when this attempt ran after a failover from another executor.
  failover?: boolean
}

function sanitizeSample(input: Zero3RoutingOutcomeInput, at: number): StoredSample {
  return {
    at,
    succeeded: input.succeeded === true,
    verificationPassed: typeof input.verificationPassed === 'boolean' ? input.verificationPassed : null,
    latencyMs: typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
      ? Math.round(input.latencyMs)
      : null,
    costUsd: typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) && input.costUsd >= 0
      ? input.costUsd
      : null,
    failover: input.failover === true
  }
}

function percentile(sortedLatencies: number[], ratio: number): number {
  if (sortedLatencies.length === 0) return 0
  const index = Math.min(sortedLatencies.length - 1, Math.ceil(sortedLatencies.length * ratio) - 1)
  return sortedLatencies[Math.max(0, index)]
}

function statsFor(samples: StoredSample[]): Zero3ExecutorTaskClassStats {
  const attempts = samples.length
  const successes = samples.filter(sample => sample.succeeded).length
  const verificationSamples = samples.filter(sample => sample.verificationPassed != null)
  const verificationPasses = verificationSamples.filter(sample => sample.verificationPassed === true).length
  const latencies = samples
    .map(sample => sample.latencyMs)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  const costs = samples.map(sample => sample.costUsd).filter((value): value is number => value != null)
  const totalCostUsd = costs.reduce((sum, value) => sum + value, 0)
  return {
    attempts,
    successes,
    failures: attempts - successes,
    verificationPasses,
    verificationFailures: verificationSamples.length - verificationPasses,
    successRate: attempts > 0 ? successes / attempts : 0,
    verificationPassRate: verificationSamples.length > 0 ? verificationPasses / verificationSamples.length : 0,
    avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    avgCostUsd: costs.length > 0 ? totalCostUsd / costs.length : 0,
    totalCostUsd
  }
}

// Durable historical-performance store for the Intelligent Agent Task Router.
// Samples are keyed by `${executorId}:${taskClass}` so the router can learn
// executor strengths per task class (e.g. Claude for large refactors, Codex for
// repository-level fixes) instead of relying on static preference tables.
export class Zero3RoutingMetricsStore {
  readonly #root: string
  readonly #maxSamples: number
  #tail: Promise<unknown> = Promise.resolve()

  constructor(root: string, options: { maxSamplesPerKey?: number } = {}) {
    if (!root?.trim()) throw new Error('routing metrics root is required')
    this.#root = root
    this.#maxSamples = options.maxSamplesPerKey ?? DEFAULT_MAX_SAMPLES
    if (!Number.isSafeInteger(this.#maxSamples) || this.#maxSamples < 10) {
      throw new Error('maxSamplesPerKey must be an integer >= 10')
    }
  }

  async recordOutcome(input: Zero3RoutingOutcomeInput): Promise<void> {
    if (!input.executorId?.trim() || !input.taskClass?.trim()) throw new Error('executorId and taskClass are required')
    const key = `${input.executorId.trim()}:${input.taskClass.trim()}`
    const sample = sanitizeSample(input, Date.now())
    await this.#mutate(async state => {
      const entry = state.keys[key] ?? { samples: [] }
      entry.samples = [...entry.samples, sample].slice(-this.#maxSamples)
      state.keys[key] = entry
      state.updatedAt = new Date().toISOString()
    })
  }

  async snapshot(): Promise<Zero3RoutingMetricsSnapshot> {
    const state = await this.#load()
    const executors: Zero3RoutingMetricsSnapshot['executors'] = {}
    for (const [key, entry] of Object.entries(state.keys)) {
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      const executorId = key.slice(0, separator)
      const taskClass = key.slice(separator + 1)
      executors[executorId] ??= {}
      executors[executorId][taskClass] = statsFor(entry.samples)
    }
    return { version: 1, updatedAt: state.updatedAt, executors }
  }

  #file(): string {
    return path.join(this.#root, 'routing-metrics-v1.json')
  }

  async #load(): Promise<StoredState> {
    try {
      const buffer = await fs.readFile(this.#file())
      const parsed = JSON.parse(buffer.toString('utf8')) as Partial<StoredState>
      if (parsed.protocol !== METRICS_PROTOCOL || parsed.version !== 1) throw new Error('routing metrics state is invalid')
      return {
        protocol: METRICS_PROTOCOL,
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {}
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { protocol: METRICS_PROTOCOL, version: 1, updatedAt: new Date().toISOString(), keys: {} }
      }
      throw error
    }
  }

  #mutate(operation: (state: StoredState) => Promise<void> | void): Promise<void> {
    const run = async () => {
      const state = await this.#load()
      await operation(state)
      await fs.mkdir(this.#root, { recursive: true })
      await zero3AtomicWriteFile(this.#file(), `${JSON.stringify(state, null, 2)}\n`)
    }
    const task = this.#tail.then(run, run)
    this.#tail = task.catch(() => undefined)
    return task
  }
}
