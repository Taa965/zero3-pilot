import assert from 'node:assert/strict'
import test from 'node:test'

import { checkpointHash } from '../../executor-runtime/handoff/handoff-hash.ts'
import { ZERO3_HANDOFF_SCHEMA, type Zero3HandoffCheckpointV1 } from '../../executor-runtime/handoff/handoff-types.ts'
import {
  ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  type DevelopmentDelivery,
  type DevelopmentSessionDefinition
} from '../contracts/index.ts'
import { auditChangedPathOwnership, computeDeliveryHash, verifyDevelopmentDelivery, type GitWorkspacePort } from './index.ts'

const base = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const session: DevelopmentSessionDefinition = {
  contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  groupId: 'G1', sessionId: 'S1', executionId: 'E1', waveId: 'W1', objective: 'Implement feature',
  baselineSha: base, integrationRef: 'integration/development-group-v1', branch: 'parallel/s1', worktree: 'C:/repo/s1',
  ownedPaths: ['src/owned/**'], readOnlyPaths: ['src/shared/**'], forbiddenPaths: ['src/forbidden/**'], dependencies: [], requirements: ['REQ-1'], inputs: [], acceptanceCriteria: ['works'],
  executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
  subagentPolicy: { allowed: true, maxConcurrency: 2, recursiveGroupCreation: false },
  deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
}

class FakeGit implements GitWorkspacePort {
  constructor(readonly changed: readonly string[], readonly dirty = false, readonly handoffFingerprint = 'handoff-fingerprint') {}
  async resolveHead() { return head }
  async currentBranch() { return session.branch }
  async branchHead() { return head }
  async isAncestor() { return true }
  async changedPaths() { return this.changed }
  async status() { return this.dirty ? [{ status: ' M', path: 'src/owned/a.ts' }] : [] }
  async handoffWorkspaceFingerprint() { return this.handoffFingerprint }
}

function delivery(changedPaths: readonly string[]): DevelopmentDelivery {
  const draft: DevelopmentDelivery = {
    contract: ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
    groupId: 'G1', sessionId: 'S1', executionId: 'E1', status: 'completed', baseSha: base, headSha: head,
    changedPaths, requirements: ['REQ-1'], testsAdded: [], testsExecuted: ['unit'], artifacts: [], knownIssues: [], downstreamNotes: [], handoffCheckpoint: '', deliveryHash: '', createdAt: '2026-09-03T00:00:00.000Z'
  }
  draft.deliveryHash = computeDeliveryHash(draft)
  return draft
}

function handoff(fingerprint: string): Zero3HandoffCheckpointV1 {
  const unsigned = {
    schema_version: ZERO3_HANDOFF_SCHEMA,
    task_id: 'G1:S1', execution_id: 'E1', workspace: session.worktree, repo_id: 'owner/repo', branch: session.branch,
    base_sha: base, head_sha: head, dirty_worktree_fingerprint: fingerprint, changed_files: [{ path: 'src/owned/a.ts', status: 'M' }], untracked_files: [], working_diff: 'diff',
    objective: session.objective, constraints: [], acceptance_criteria: session.acceptanceCriteria, completed: ['implementation'], in_progress: [], remaining: [], tests_run: ['unit'], test_results: [{ name: 'unit', status: 'passed' as const }], pending_approvals: [],
    last_executor: 'native-codex', last_session_id: 'thread-1', stop_reason: 'completed', next_action: 'deliver', handoff_generation: 1, created_at: '2026-09-03T00:00:00.000Z'
  }
  return { ...unsigned, checkpoint_hash: checkpointHash(unsigned) }
}

test('ownership rejects forbidden, read-only and unowned changed paths', () => {
  const audit = auditChangedPathOwnership(['src/owned/a.ts', 'src/shared/b.ts', 'src/forbidden/c.ts', 'other.ts'], session)
  assert.equal(audit.valid, false)
  assert.deepEqual(audit.violations.map(item => item.authority).sort(), ['forbidden', 'read_only', 'unowned'])
})

test('delivery gate accepts only exact Git, ownership, hash and existing Handoff evidence', async () => {
  const changed = ['src/owned/a.ts']
  const draft = delivery(changed)
  const git = new FakeGit(changed)
  const checkpoint = handoff(git.handoffFingerprint)
  draft.handoffCheckpoint = checkpoint.checkpoint_hash
  draft.deliveryHash = computeDeliveryHash(draft)
  const result = await verifyDevelopmentDelivery({ delivery: draft, session, git, handoff: { checkpoint } })
  assert.equal(result.decision, 'DELIVERY_ACCEPT')
})

test('delivery gate rejects Handoff evidence when independent R4E fingerprint differs', async () => {
  const draft = delivery(['src/owned/a.ts'])
  const checkpoint = handoff('checkpoint-fingerprint')
  draft.handoffCheckpoint = checkpoint.checkpoint_hash
  draft.deliveryHash = computeDeliveryHash(draft)
  const result = await verifyDevelopmentDelivery({ delivery: draft, session, git: new FakeGit(['src/owned/a.ts'], false, 'observed-fingerprint'), handoff: { checkpoint } })
  assert.equal(result.decision, 'DELIVERY_REJECT')
  assert.ok(result.reasons.some(reason => reason.includes('worktree fingerprint mismatch')))
})

test('delivery gate fails closed on dirty worktree or ownership violation', async () => {
  const dirtyResult = await verifyDevelopmentDelivery({ delivery: delivery(['src/owned/a.ts']), session: { ...session, deliveryPolicy: { ...session.deliveryPolicy, requireHandoff: false } }, git: new FakeGit(['src/owned/a.ts'], true) })
  assert.equal(dirtyResult.decision, 'DELIVERY_REJECT')
  const forbiddenResult = await verifyDevelopmentDelivery({ delivery: delivery(['src/forbidden/x.ts']), session: { ...session, deliveryPolicy: { ...session.deliveryPolicy, requireHandoff: false } }, git: new FakeGit(['src/forbidden/x.ts']) })
  assert.equal(forbiddenResult.decision, 'DELIVERY_REJECT')
})
