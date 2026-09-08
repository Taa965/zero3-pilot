import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HandoffStore } from '../../executor-runtime/handoff/handoff-store.ts'
import {
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  type DevelopmentGroupDefinition,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime
} from '../contracts/index.ts'
import { GitWorkspaceAdapter } from '../workspace/index.ts'
import { WorkspaceDeliveryMaterializer } from './delivery-materializer.ts'

type Fixture = {
  root: string
  repo: string
  baseSha: string
  group: DevelopmentGroupDefinition
  session: DevelopmentSessionDefinition
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zero3-delivery-materializer-'))
  const repo = path.join(root, 'repo')
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await mkdir(path.join(repo, 'forbidden'), { recursive: true })
  git(repo, ['init', '-b', 'session'])
  git(repo, ['config', 'user.name', 'Zero3 Test'])
  git(repo, ['config', 'user.email', 'zero3@example.invalid'])
  await writeFile(path.join(repo, 'src', 'feature.ts'), 'export const feature = 1\n')
  await writeFile(path.join(repo, 'src', 'rename-me.ts'), 'export const renameMe = 1\n')
  await writeFile(path.join(repo, 'forbidden', 'secret.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'baseline'])
  const baseSha = git(repo, ['rev-parse', 'HEAD'])

  const group: DevelopmentGroupDefinition = {
    contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
    groupId: 'G-MATERIALIZE',
    repository: repo,
    masterGoal: 'Ship safely',
    masterPrompt: 'Implement the bounded change',
    developmentPlan: 'One bounded Session',
    planHash: 'materialize-plan',
    baselineSha: baseSha,
    integrationRef: 'integration/development-group-v1',
    requirementIds: ['REQ-1'],
    waveIds: ['W01'],
    sessionIds: ['S01'],
    policy: {
      maxParallelSessions: 6,
      maxSessionAttempts: 3,
      maxRepairSessions: 3,
      maxRepairWaves: 3,
      maxSameFailureAttempts: 2,
      maxSessionSubagents: 4,
      permissionProfile: 'standard',
      completionMode: 'strict',
      verificationPolicyRevision: 'v1',
      targetBranch: 'integration/development-group-v1',
      protectedPaths: [],
      mandatoryTests: ['typecheck']
    },
    createdAt: '2026-09-08T00:00:00.000Z'
  }
  const session: DevelopmentSessionDefinition = {
    contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
    groupId: group.groupId,
    sessionId: 'S01',
    executionId: 'E01',
    waveId: 'W01',
    objective: 'Implement the bounded change',
    baselineSha: baseSha,
    integrationRef: group.integrationRef,
    branch: 'session',
    worktree: repo,
    ownedPaths: ['src/**'],
    readOnlyPaths: [],
    forbiddenPaths: ['forbidden/**'],
    dependencies: [],
    requirements: ['REQ-1'],
    inputs: [],
    acceptanceCriteria: ['change is committed'],
    executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
    subagentPolicy: { allowed: true, maxConcurrency: 4, recursiveGroupCreation: false },
    deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
  }
  return { root, repo, baseSha, group, session }
}

function runtime(executorId: string): DevelopmentSessionRuntime {
  return {
    groupId: 'G-MATERIALIZE',
    sessionId: 'S01',
    executionId: 'E01',
    status: 'delivering',
    attempt: 1,
    writerGeneration: executorId === 'claude' ? 2 : 1,
    executorId,
    executorSessionId: `${executorId}-session`,
    executorGeneration: executorId === 'claude' ? 2 : 1,
    lastEventSequence: 2,
    updatedAt: '2026-09-08T00:00:00.000Z'
  }
}

function materializer(root: string) {
  return new WorkspaceDeliveryMaterializer(new HandoffStore(path.join(root, 'handoffs')), {
    materializeDirtyExecutorIds: ['claude']
  })
}
test('Claude dirty owned edits are ownership-audited and committed by Zero3 before Delivery materialization', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'src', 'feature.ts'), 'export const feature = 2\n')
    const delivery = await materializer(f.root).materialize(f.group, f.session, runtime('claude'))
    const workspace = new GitWorkspaceAdapter(f.repo)
    const head = await workspace.resolveHead()

    assert.notEqual(head, f.baseSha)
    assert.equal(delivery.headSha, head)
    assert.deepEqual(delivery.changedPaths, ['src/feature.ts'])
    assert.deepEqual(await workspace.status(), [])
    assert.equal(git(f.repo, ['log', '-1', '--pretty=%s']), 'zero3: materialize G-MATERIALIZE/S01 claude delivery')
    assert.equal(await readFile(path.join(f.repo, 'src', 'feature.ts'), 'utf8'), 'export const feature = 2\n')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Claude dirty forbidden edits are rejected before staging or committing', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'forbidden', 'secret.txt'), 'changed\n')
    await assert.rejects(
      materializer(f.root).materialize(f.group, f.session, runtime('claude')),
      /controller commit refused dirty ownership violation: forbidden\/secret\.txt=forbidden/
    )
    assert.equal(await new GitWorkspaceAdapter(f.repo).resolveHead(), f.baseSha)
    assert.equal(git(f.repo, ['diff', '--cached', '--name-only']), '')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('native dirty worktree is not auto-committed by the Claude-only controller path', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'src', 'feature.ts'), 'export const feature = 3\n')
    await assert.rejects(
      materializer(f.root).materialize(f.group, f.session, runtime('native-codex')),
      /Delivery materialization requires a clean committed worktree/
    )
    assert.equal(await new GitWorkspaceAdapter(f.repo).resolveHead(), f.baseSha)
    assert.equal(git(f.repo, ['diff', '--cached', '--name-only']), '')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('pre-staged rename retains both source and destination authority and rejects forbidden destination', async () => {
  const f = await fixture()
  try {
    await rename(path.join(f.repo, 'src', 'rename-me.ts'), path.join(f.repo, 'forbidden', 'renamed.ts'))
    git(f.repo, ['add', '-A'])
    const status = await new GitWorkspaceAdapter(f.repo).status()
    assert.equal(status[0]?.status.startsWith('R'), true)
    assert.equal(status[0]?.path, 'forbidden/renamed.ts')
    assert.equal(status[0]?.originalPath, 'src/rename-me.ts')
    await assert.rejects(
      materializer(f.root).materialize(f.group, f.session, runtime('claude')),
      /forbidden\/renamed\.ts=forbidden/
    )
    assert.equal(await new GitWorkspaceAdapter(f.repo).resolveHead(), f.baseSha)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('pre-staged owned changes are not adopted by the Claude controller commit path', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'src', 'feature.ts'), 'export const feature = 4\n')
    git(f.repo, ['add', 'src/feature.ts'])
    await assert.rejects(
      materializer(f.root).materialize(f.group, f.session, runtime('claude')),
      /controller commit refuses pre-staged index changes: src\/feature\.ts/
    )
    assert.equal(await new GitWorkspaceAdapter(f.repo).resolveHead(), f.baseSha)
    assert.equal(git(f.repo, ['diff', '--cached', '--name-only']), 'src/feature.ts')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
