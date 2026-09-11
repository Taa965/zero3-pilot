import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadZero3RemoteHostConfig } from './remote-config.ts'

const ENV_KEYS = [
  'ZERO3_REMOTE_HOST_ENABLED', 'ZERO3_REMOTE_HOST_BASE_URL', 'ZERO3_REMOTE_HOST_TOKEN_FILE',
  'ZERO3_REMOTE_HOST_NODE_ID', 'ZERO3_REMOTE_HOST_WORKSPACES', 'ZERO3_REMOTE_HOST_ALLOW_HTTP',
  'ZERO3_WORKER_TUNNEL_ENABLED', 'ZERO3_WORKER_TUNNEL_BASE_URL', 'ZERO3_WORKER_TUNNEL_TOKEN_FILE',
  'ZERO3_WORKER_TUNNEL_NODE_ID', 'ZERO3_WORKER_TUNNEL_ALLOW_HTTP', 'ZERO3_SKILL_TUNNEL_ENABLED'
] as const

function withCleanEnv(run: () => void) {
  const saved = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  try {
    for (const key of ENV_KEYS) delete process.env[key]
    run()
  } finally {
    for (const [key, value] of saved) value == null ? delete process.env[key] : process.env[key] = value
  }
}

test('Worker Tunnel can run without enabling remote Codex task execution', () => {
  withCleanEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-worker-tunnel-config-'))
    const token = path.join(root, 'host.token')
    fs.writeFileSync(token, 'local-test-token')
    process.env.ZERO3_WORKER_TUNNEL_ENABLED = '1'
    process.env.ZERO3_WORKER_TUNNEL_BASE_URL = 'https://pilot.example.test'
    process.env.ZERO3_WORKER_TUNNEL_TOKEN_FILE = token
    process.env.ZERO3_WORKER_TUNNEL_NODE_ID = 'worker-node'
    const config = loadZero3RemoteHostConfig()
    assert.equal(config.enabled, false)
    assert.equal(config.workerTunnelEnabled, true)
    assert.equal(config.skillTunnelEnabled, false)
    assert.equal(config.nodeId, 'worker-node')
    assert.deepEqual(config.allowedWorkspaces, [])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
test('Skill Tunnel requires an allow-listed workspace while remote tasks stay disabled', () => {
  withCleanEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-skill-tunnel-config-'))
    const token = path.join(root, 'host.token')
    const workspace = path.join(root, 'workspace')
    fs.writeFileSync(token, 'local-test-token')
    fs.mkdirSync(workspace)
    process.env.ZERO3_SKILL_TUNNEL_ENABLED = '1'
    process.env.ZERO3_WORKER_TUNNEL_BASE_URL = 'https://pilot.example.test'
    process.env.ZERO3_WORKER_TUNNEL_TOKEN_FILE = token
    process.env.ZERO3_REMOTE_HOST_WORKSPACES = workspace
    const config = loadZero3RemoteHostConfig()
    assert.equal(config.enabled, false)
    assert.equal(config.workerTunnelEnabled, false)
    assert.equal(config.skillTunnelEnabled, true)
    assert.deepEqual(config.allowedWorkspaces, [path.resolve(workspace)])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
