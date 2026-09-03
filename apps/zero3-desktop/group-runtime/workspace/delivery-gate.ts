import { createHash } from 'node:crypto'

import { verifyHandoff } from '../../executor-runtime/handoff/handoff-verifier.ts'
import type { HandoffObservedWorkspace, Zero3HandoffCheckpointV1 } from '../../executor-runtime/handoff/handoff-types.ts'
import {
  validateDevelopmentDelivery,
  type DevelopmentDelivery,
  type DevelopmentSessionDefinition
} from '../contracts/index.ts'
import type { GitWorkspacePort } from './git-workspace.ts'
import { auditChangedPathOwnership, type OwnershipAudit } from './ownership.ts'
import { workspaceFingerprint } from './workspace-fingerprint.ts'

export interface DeliveryHandoffEvidence {
  checkpoint: Zero3HandoffCheckpointV1
}

export interface DeliveryGateResult {
  decision: 'DELIVERY_ACCEPT' | 'DELIVERY_REJECT'
  reasons: readonly string[]
  observed: {
    branch?: string
    headSha?: string
    changedPaths: readonly string[]
    dirty: boolean
    workspaceFingerprint?: string
    handoffDirtyWorktreeFingerprint?: string
  }
  ownership?: OwnershipAudit
}

function normalizedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(path => path.replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))].sort()
}

export function computeDeliveryHash(delivery: DevelopmentDelivery): string {
  const { deliveryHash: _ignored, ...unsigned } = delivery
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(unsigned)))
    .digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return value
}

export async function verifyDevelopmentDelivery(input: {
  delivery: DevelopmentDelivery
  session: DevelopmentSessionDefinition
  git: GitWorkspacePort
  handoff?: DeliveryHandoffEvidence
  integrationExceptions?: readonly string[]
}): Promise<DeliveryGateResult> {
  const { delivery, session, git } = input
  const reasons = validateDevelopmentDelivery(delivery, session).map(item => `${item.code}: ${item.message}`)
  let branch: string | undefined
  let headSha: string | undefined
  let changedPaths: readonly string[] = []
  let status = [] as Awaited<ReturnType<GitWorkspacePort['status']>>
  let fingerprint: string | undefined
  let handoffDirtyWorktreeFingerprint: string | undefined
  let ownership: OwnershipAudit | undefined

  try {
    ;[branch, headSha, changedPaths, status] = await Promise.all([
      git.currentBranch(),
      git.resolveHead(),
      git.changedPaths(session.baselineSha, delivery.headSha),
      git.status()
    ])
  } catch (error) {
    reasons.push(`git evidence unavailable: ${String(error)}`)
    return { decision: 'DELIVERY_REJECT', reasons, observed: { changedPaths: [], dirty: true } }
  }

  if (branch !== session.branch) reasons.push(`branch mismatch: expected ${session.branch}, got ${branch}`)
  if (headSha !== delivery.headSha) reasons.push(`HEAD mismatch: expected ${delivery.headSha}, got ${headSha}`)
  try {
    if ((await git.branchHead(session.branch)) !== delivery.headSha) reasons.push('delivery head is not the bound branch head')
    if (!(await git.isAncestor(session.baselineSha, delivery.headSha))) reasons.push('delivery head is not descended from the frozen baseline')
  } catch (error) {
    reasons.push(`ancestry evidence unavailable: ${String(error)}`)
  }

  const expectedChangedPaths = normalizedPaths(delivery.changedPaths)
  const observedChangedPaths = normalizedPaths(changedPaths)
  if (JSON.stringify(expectedChangedPaths) !== JSON.stringify(observedChangedPaths)) {
    reasons.push('delivery changed_paths do not match Git diff evidence')
  }
  if (session.deliveryPolicy.requireCleanHead && status.length > 0) reasons.push('delivery requires a clean worktree but Git status is dirty/untracked')

  ownership = auditChangedPathOwnership(observedChangedPaths, session, input.integrationExceptions ?? [])
  if (session.deliveryPolicy.requireOwnershipValidation && !ownership.valid) {
    reasons.push(`ownership violation: ${ownership.violations.map(item => `${item.path}=${item.authority}`).join(', ')}`)
  }

  const computedHash = computeDeliveryHash(delivery)
  if (session.deliveryPolicy.requireDeliveryHash && computedHash !== delivery.deliveryHash) reasons.push('delivery hash mismatch')

  fingerprint = workspaceFingerprint({
    branch,
    headSha,
    baseSha: session.baselineSha,
    changedPaths: observedChangedPaths,
    status
  })

  if (session.deliveryPolicy.requireHandoff) {
    if (!input.handoff) {
      reasons.push('required zero3.pilot.handoff.v1 evidence is missing')
    } else {
      const checkpoint = input.handoff.checkpoint
      if (checkpoint.execution_id !== session.executionId) reasons.push('handoff execution identity does not match Development Session')
      if (checkpoint.base_sha !== session.baselineSha) reasons.push('handoff baseline does not match Development Session')
      if (delivery.handoffCheckpoint && delivery.handoffCheckpoint !== checkpoint.checkpoint_hash) reasons.push('delivery handoff checkpoint reference does not match supplied checkpoint')
      try {
        handoffDirtyWorktreeFingerprint = git.handoffDirtyWorktreeFingerprint
          ? await git.handoffDirtyWorktreeFingerprint()
          : fingerprint
      } catch (error) {
        reasons.push(`handoff fingerprint evidence unavailable: ${String(error)}`)
      }
      if (handoffDirtyWorktreeFingerprint) {
        const observed: HandoffObservedWorkspace = {
          workspace: session.worktree,
          branch,
          headSha,
          dirtyWorktreeFingerprint: handoffDirtyWorktreeFingerprint
        }
        const handoffResult = verifyHandoff(checkpoint, observed)
        if (handoffResult.decision !== 'HANDOFF_ACCEPT') reasons.push(...handoffResult.reasons.map(reason => `handoff: ${reason}`))
      }
    }
  }

  return {
    decision: reasons.length === 0 ? 'DELIVERY_ACCEPT' : 'DELIVERY_REJECT',
    reasons,
    observed: {
      branch,
      headSha,
      changedPaths: observedChangedPaths,
      dirty: status.length > 0,
      workspaceFingerprint: fingerprint,
      handoffDirtyWorktreeFingerprint
    },
    ownership
  }
}
