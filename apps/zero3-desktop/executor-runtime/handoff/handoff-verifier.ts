import path from 'node:path'

import { verifyCheckpointHash } from './handoff-hash.ts'
import {
  ZERO3_HANDOFF_SCHEMA,
  type HandoffObservedWorkspace,
  type HandoffVerificationResult,
  type Zero3HandoffCheckpointV1
} from './handoff-types.ts'

export const HANDOFF_VERIFY_INSTRUCTION = `HANDOFF_VERIFY

Do not modify code yet.

1. Confirm workspace.
2. Confirm branch.
3. Confirm HEAD.
4. Read the handoff checkpoint.
5. Inspect git status.
6. Inspect diff.
7. Inspect untracked files.
8. Inspect last test results.
9. Confirm pending approvals.
10. Confirm next_action.
11. Return HANDOFF_ACCEPT or HANDOFF_REJECT with reasons.`

function missingEvidence(checkpoint: Zero3HandoffCheckpointV1): string[] {
  const reasons: string[] = []
  for (const [name, value] of [
    ['task_id', checkpoint.task_id],
    ['execution_id', checkpoint.execution_id],
    ['workspace', checkpoint.workspace],
    ['repo_id', checkpoint.repo_id],
    ['branch', checkpoint.branch],
    ['base_sha', checkpoint.base_sha],
    ['head_sha', checkpoint.head_sha],
    ['dirty_worktree_fingerprint', checkpoint.dirty_worktree_fingerprint],
    ['objective', checkpoint.objective],
    ['last_executor', checkpoint.last_executor],
    ['last_session_id', checkpoint.last_session_id],
    ['stop_reason', checkpoint.stop_reason],
    ['next_action', checkpoint.next_action],
    ['created_at', checkpoint.created_at]
  ] as const) {
    if (!value?.trim()) reasons.push(`missing required evidence: ${name}`)
  }
  if (!Number.isSafeInteger(checkpoint.handoff_generation) || checkpoint.handoff_generation < 1) {
    reasons.push('invalid handoff_generation')
  }
  if (!Array.isArray(checkpoint.tests_run) || !Array.isArray(checkpoint.test_results)) reasons.push('missing test evidence')
  if (!Array.isArray(checkpoint.pending_approvals)) reasons.push('missing pending approval evidence')
  return reasons
}

export function verifyHandoff(
  checkpoint: Zero3HandoffCheckpointV1,
  observed: HandoffObservedWorkspace
): HandoffVerificationResult {
  const reasons = missingEvidence(checkpoint)
  if (checkpoint.schema_version !== ZERO3_HANDOFF_SCHEMA) reasons.push('unsupported schema_version')
  if (!verifyCheckpointHash(checkpoint)) reasons.push('checkpoint hash mismatch')
  if (path.resolve(observed.workspace) !== path.resolve(checkpoint.workspace)) reasons.push('workspace mismatch')
  if (observed.branch !== checkpoint.branch) reasons.push('branch mismatch')
  if (observed.headSha !== checkpoint.head_sha) reasons.push('HEAD mismatch')
  if (observed.dirtyWorktreeFingerprint !== checkpoint.dirty_worktree_fingerprint) reasons.push('worktree fingerprint mismatch')
  return {
    decision: reasons.length === 0 ? 'HANDOFF_ACCEPT' : 'HANDOFF_REJECT',
    reasons,
    task_id: checkpoint.task_id,
    execution_id: checkpoint.execution_id,
    checkpoint_hash: checkpoint.checkpoint_hash,
    generation: checkpoint.handoff_generation
  }
}
