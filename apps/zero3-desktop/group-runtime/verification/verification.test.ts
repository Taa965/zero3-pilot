import assert from 'node:assert/strict'
import test from 'node:test'

import type { DevelopmentGroupPolicy, DevelopmentSessionDefinition, VerificationCommand } from '../contracts/index.ts'
import { attributeFailure, executeVerification, planRepairWave } from './index.ts'

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const commands: VerificationCommand[] = [
  { id: 'unit', command: 'unit-tests', platform: 'any', required: true },
  { id: 'windows-package', command: 'windows-package', platform: 'windows', required: true }
]

test('required platform mismatch is NOT_RUN_PLATFORM and cannot make run pass', async () => {
  const run = await executeVerification({ groupId: 'G1', integrationSha: sha, policyRevision: 'v1', commands, environment: {}, platform: 'linux', verificationRunId: 'V1' }, { async run() { return { exitCode: 0, evidence: ['ok'] } } })
  assert.equal(run.results.find(result => result.commandId === 'windows-package')?.status, 'not_run_platform')
  assert.equal(run.status, 'failed')
})

test('verification executor exception becomes OutcomeUnknown rather than inferred failure', async () => {
  const run = await executeVerification({ groupId: 'G1', integrationSha: sha, policyRevision: 'v1', commands: commands.slice(0, 1), environment: {}, platform: 'linux', verificationRunId: 'V2' }, { async run() { throw new Error('runner disappeared') } })
  assert.equal(run.status, 'outcome_unknown')
  assert.equal(run.results[0].status, 'not_run')
})

test('failure attribution uses owned paths and repair planner refuses OutcomeUnknown automation', () => {
  const session = { sessionId: 'S1', ownedPaths: ['src/a/**'], readOnlyPaths: [], forbiddenPaths: [] } as DevelopmentSessionDefinition
  const normal = attributeFailure({ groupId: 'G1', signal: 'command_failed', message: 'compile', evidence: ['exit=1'], changedPaths: ['src/a/x.ts'] }, [session])
  assert.deepEqual(normal.ownerSessionIds, ['S1'])
  const unknown = attributeFailure({ groupId: 'G1', signal: 'outcome_unknown', message: 'unknown', evidence: ['transport lost'], involvedSessionIds: ['S1'] }, [session])
  const policy = { maxRepairWaves: 2, maxRepairSessions: 2, maxSameFailureAttempts: 2 } as DevelopmentGroupPolicy
  const tasks = planRepairWave({ groupId: 'G1', waveOrdinal: 1, failures: [normal, unknown], policy })
  assert.ok(tasks.some(task => task.status === 'planned'))
  assert.ok(tasks.some(task => task.status === 'waiting_human'))
})
