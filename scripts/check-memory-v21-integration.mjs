import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

for (const script of [
  'deployment/memory/deploy-memory-authority.sh',
  'deployment/memory/migrate.sh',
  'deployment/memory/server/bootstrap-zero3memory.sh'
]) {
  execFileSync('bash', ['-n', path.join(root, script)], { stdio: 'inherit' })
}

const baseMigration = read('deployment/memory/migrations/001_memory_authority_v2_1.sql')
const confidenceMigration = read('deployment/memory/migrations/008_memory_authority_v2_1_confidence_f64.sql')
assert.match(baseMigration, /confidence DOUBLE PRECISION CHECK/)
assert.doesNotMatch(baseMigration, /confidence REAL CHECK/)
assert.match(confidenceMigration, /ALTER COLUMN confidence TYPE DOUBLE PRECISION/)

const unit = read('deployment/memory/systemd/zero3-memory-authority.service')
assert.match(unit, /User=zero3memory/)
assert.match(unit, /WorkingDirectory=\/opt\/zero3-memory-runtime\/current/)
assert.match(unit, /ExecStart=\/opt\/zero3-memory-runtime\/current\/bin\/zero3-memory-server/)
assert.match(unit, /Environment=ZERO3_MEMORY_BIND=127\.0\.0\.1:8791/)

const deploy = read('deployment/memory/deploy-memory-authority.sh')
assert.match(deploy, /id -un.*zero3memory/s)
assert.match(deploy, /sudo \/usr\/local\/sbin\/zero3memory-deploy-release/)
assert.doesNotMatch(deploy, /systemctl restart zero3-memory-authority/)
assert.doesNotMatch(deploy, /ZERO3_MEMORY_MIGRATION_DATABASE_URL/)

const bootstrap = read('deployment/memory/server/bootstrap-zero3memory.sh')
assert.match(bootstrap, /zero3memory-deploy-release/)
assert.match(bootstrap, /systemctl restart zero3-memory-authority\.service/)
assert.match(bootstrap, /nginx -t/)
assert.doesNotMatch(bootstrap, /systemctl restart nginx/)

const nginx = read('deployment/memory/nginx/zero3-memory-authority.conf.template')
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8791/)
assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/)
assert.doesNotMatch(nginx, /listen 8791/)

const workflow = read('deployment/memory/github-inbox-template/.github/workflows/relay-memory-event.yml')
assert.match(workflow, /ZERO3_MEMORY_INGRESS_TOKEN/)
assert.match(workflow, /status.*accepted.*duplicate/s)
assert.match(workflow, /name-status/)

const validator = path.join(root, 'deployment/memory/github-inbox-template/scripts/validate-memory-event.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-memory-v21-'))
try {
  const eventId = '11111111-1111-4111-8111-111111111111'
  const relative = `events/project-a/2026/09/${eventId}.json`
  const validPath = path.join(tmp, ...relative.split('/'))
  fs.mkdirSync(path.dirname(validPath), { recursive: true })
  const base = {
    schema: 'zero3.memory.event.v1',
    event_id: eventId,
    created_at: '2026-09-08T03:00:00Z',
    scope: { project_id: 'project-a', task_id: 'task-a', session_id: null, thread_id: null },
    actor: { agent_id: 'gpt-web', agent_type: 'gpt_web', device_id: null },
    event_type: 'decision.recorded',
    memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-a', authority: 60, confidence: 0.9 },
    source: { type: 'github_inbox', ref: 'chatgpt-web', hash: null },
    supersedes: [],
    payload: { text: 'AWS is the shared memory authority' }
  }
  fs.writeFileSync(validPath, JSON.stringify(base))
  let run = spawnSync(process.execPath, [validator, relative], { cwd: tmp, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)

  fs.writeFileSync(validPath, JSON.stringify({ ...base, payload: { api_key: 'do-not-store-me' } }))
  run = spawnSync(process.execPath, [validator, relative], { cwd: tmp, encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /forbidden key|validation failed/i)

  fs.writeFileSync(validPath, JSON.stringify({ ...base, memory: { ...base.memory, class: 'personal', authority: 20 } }))
  run = spawnSync(process.execPath, [validator, relative], { cwd: tmp, encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /personal memory is forbidden/i)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('Zero3 Memory Authority V2.1 integration static checks passed')
