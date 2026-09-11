import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { executeZero3SkillRpc, type Zero3SkillRuntimePort } from './remote-skill-rpc.ts'
import type { Zero3RemoteWorkerRpcLease } from './remote-types.ts'

function lease(tool: Zero3RemoteWorkerRpcLease['tool'], argumentsValue: Record<string, unknown>): Zero3RemoteWorkerRpcLease {
  return {
    request_id: 'srpc-1',
    capability: 'codex-native-skills-v1',
    lease_id: 'lease-1',
    fencing_token: 1,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    tool,
    arguments: argumentsValue
  }
}

class FakeSkillRuntime implements Zero3SkillRuntimePort {
  startThreadParams: Record<string, unknown> | null = null
  startTurnParams: Record<string, unknown> | null = null
  readonly skillPath: string
  constructor(skillPath = '/home/user/.codex/skills/demo-skill/SKILL.md') { this.skillPath = skillPath }

  async listSkills() {
    return {
      data: [{
        cwd: '/workspace',
        skills: [{
          name: 'demo-skill', description: 'Demo Skill', shortDescription: 'demo',
          path: this.skillPath, scope: 'user', enabled: true,
          pluginId: null, interface: { displayName: 'Demo Skill' }
        }],
        errors: []
      }]
    }
  }
  async startThread(params: Record<string, unknown>) {
    this.startThreadParams = params
    return { thread: { id: 'thread-1' } }
  }
  async startTurn(params: Record<string, unknown>) {
    this.startTurnParams = params
    return { turn: { id: 'turn-1' } }
  }
  async readThread() {
    return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'skill result' }] }] } }
  }
}

test('list/search never return the local Skill absolute path', async () => {
  const runtime = new FakeSkillRuntime()
  const listed = await executeZero3SkillRpc(runtime, lease('list_skills', {}))
  const searched = await executeZero3SkillRpc(runtime, lease('search_skills', { query: 'demo' }))
  assert.doesNotMatch(JSON.stringify(listed), /\.codex\/skills/)
  assert.doesNotMatch(JSON.stringify(searched), /\.codex\/skills/)
  assert.match(JSON.stringify(listed), /demo-skill/)
})

test('get_skill returns bounded Skill instructions without the local absolute path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-skill-read-'))
  const file = path.join(root, 'SKILL.md')
  fs.writeFileSync(file, '# Demo\n\nUse the demo workflow.')
  try {
    const result = await executeZero3SkillRpc(new FakeSkillRuntime(file), lease('get_skill', { selector: 'demo-skill' }))
    assert.match(JSON.stringify(result), /Use the demo workflow/)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invoke_skill uses native Codex skill input and requires a cwd', async () => {
  const runtime = new FakeSkillRuntime()
  const result = await executeZero3SkillRpc(runtime, lease('invoke_skill', {
    selector: 'demo-skill', prompt: 'Do the bounded task', cwd: '/workspace', idempotencyKey: 'invoke-1'
  })) as Record<string, unknown>
  assert.equal(result.result, 'skill result')
  assert.deepEqual(runtime.startThreadParams, { cwd: '/workspace', approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: false })
  const input = runtime.startTurnParams?.input as Array<Record<string, unknown>>
  assert.deepEqual(input[0], { type: 'skill', name: 'demo-skill', path: '/home/user/.codex/skills/demo-skill/SKILL.md' })
  assert.equal(input[1].type, 'text')
  assert.doesNotMatch(JSON.stringify(result), /\.codex\/skills/)

  await assert.rejects(
    executeZero3SkillRpc(runtime, lease('invoke_skill', { selector: 'demo-skill', prompt: 'x', idempotencyKey: 'invoke-2' })),
    /cwd is required/
  )
})
