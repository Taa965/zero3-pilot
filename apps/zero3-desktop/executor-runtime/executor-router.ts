import { failurePolicyFor, isExecutorFailure } from './failure-normalizer.ts'
import type { ExecutorFailure, ExecutorId } from './executor-types.ts'
import type { Zero3ExecutorRegistry } from './executor-registry.ts'

export class ExecutorRoutingError extends Error {}

export interface ExecutorRoutePlan {
  primary: ExecutorId
  fallbacks: readonly ExecutorId[]
}

export class Zero3ExecutorRouter {
  constructor(
    private readonly registry: Zero3ExecutorRegistry,
    readonly plan: ExecutorRoutePlan
  ) {
    const all = [plan.primary, ...plan.fallbacks]
    if (new Set(all).size !== all.length) {
      throw new ExecutorRoutingError('executor route plan cannot contain duplicate ids')
    }
  }

  primary(): ExecutorId {
    this.registry.require(this.plan.primary)
    return this.plan.primary
  }

  manual(executorId: ExecutorId): ExecutorId {
    this.registry.require(executorId)
    return executorId
  }

  fallbackCandidatesAfter(executorId: ExecutorId, failure: ExecutorFailure): readonly ExecutorId[] {
    if (!isExecutorFailure(failure)) {
      throw new ExecutorRoutingError('executor failure must use the frozen Zero3 failure taxonomy')
    }
    if (failurePolicyFor(failure.code).failover === 'forbidden') return []
    const ordered = [this.plan.primary, ...this.plan.fallbacks]
    const current = ordered.indexOf(executorId)
    if (current < 0) throw new ExecutorRoutingError(`executor is not present in route plan: ${executorId}`)
    return ordered.slice(current + 1).filter(id => this.registry.get(id))
  }
}
