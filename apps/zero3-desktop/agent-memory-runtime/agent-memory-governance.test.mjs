import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentMemoryGovernanceError,
  assertAgentMemoryAdapter,
  assertFailoverFreshness,
  buildContextManifest,
  buildFailoverHandoff,
  nativeMemoryPolicy,
  promoteCandidates,
  resolveContext
} from './agent-memory-governance.mjs'

test('Zero3 project authority beats newer provider native memory', () => {
  const resolved = resolveContext([
    { key: 'memory.backend', layer: 'native_working_memory', authority: 0, sequence: 999, value: 'local-json' },
    { key: 'memory.backend', layer: 'project_authority', authority: 85, sequence: 100, value: 'aws-postgres' }
  ])
  assert.equal(resolved.items[0].value, 'aws-postgres')
  assert.deepEqual(resolved.native_context_stale_items, ['memory.backend'])
})

test('adapter contract requires all lifecycle methods', () => {
  assert.throws(() => assertAgentMemoryAdapter({ prepareContext() {} }), error => error instanceof AgentMemoryGovernanceError && error.code === 'invalid_adapter')
  const complete = Object.fromEntries(['prepareContext','captureResult','extractMemoryCandidates','publishMemoryEvents','publishHandoff'].map(name => [name, () => {}]))
  assert.equal(assertAgentMemoryAdapter(complete), complete)
})

test('agent cannot promote user authority or unverified durable inference', () => {
  const { accepted, rejected } = promoteCandidates([
    { candidate_type: 'decision', scope: 'project', proposed_authority: 100, verification_status: 'verified' },
    { candidate_type: 'inference', scope: 'project', proposed_authority: 20, verification_status: 'unverified' },
    { candidate_type: 'pitfall', scope: 'project', proposed_authority: 45, verification_status: 'verified' }
  ], { maxAuthority: 60 })
  assert.equal(accepted.length, 1)
  assert.deepEqual(rejected.map(item => item.code), ['authority_escalation', 'unverified_durable_memory'])
})

test('stale failover handoff is blocked until catchup', () => {
  assert.throws(
    () => assertFailoverFreshness({ handoffProjectSequence: 40, currentProjectSequence: 42, handoffTaskSequence: 8, currentTaskSequence: 8 }),
    error => error instanceof AgentMemoryGovernanceError && error.code === 'stale_handoff' && error.details.projectGap === 2
  )
  assert.equal(assertFailoverFreshness({ handoffProjectSequence: 42, currentProjectSequence: 42, handoffTaskSequence: 8, currentTaskSequence: 8 }), true)
})

test('context manifest remains valid without provider native session', () => {
  const resolved = resolveContext([{ key: 'decision-1', layer: 'project_authority', authority: 85, sequence: 7, value: 'B' }])
  const manifest = buildContextManifest({ projectId: 'project-a', projectSequence: 7, taskSequence: 2, resolved, nativeContextUsed: false })
  assert.equal(manifest.native_context_used, false)
  assert.deepEqual(manifest.authority_items, ['decision-1'])
})

test('handoff requires shared-memory sequences instead of whole provider chat', () => {
  const handoff = buildFailoverHandoff({
    project_id: 'project-a', task_id: 'task-a', requirements: ['ship'], current_task_state: 'running',
    completed_work: ['protocol'], remaining_work: ['server'], verified_results: [], known_blockers: [],
    artifact_refs: [], commit_refs: [], workspace_ownership: { paths: ['apps/memory-server'] },
    project_authority_sequence: 12, task_memory_sequence: 9
  })
  assert.equal(handoff.protocol, 'zero3.memory.handoff.v2')
  assert.equal(Object.hasOwn(handoff, 'full_chat_transcript'), false)
})

test('all provider native memories are explicitly working-only', () => {
  for (const provider of ['codex', 'claude', 'antigravity', 'zero3']) {
    const policy = nativeMemoryPolicy(provider)
    assert.equal(policy.role, 'working_memory_only')
    assert.equal(policy.can_be_project_authority, false)
    assert.equal(policy.conflict_rule, 'zero3_authority_wins')
  }
})
