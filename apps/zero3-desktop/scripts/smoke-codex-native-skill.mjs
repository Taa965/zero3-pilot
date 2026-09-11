// End-to-end smoke: the pinned Codex app-server must accept Zero3's native
// skill Turn input ({type:'skill'}) and answer from the referenced SKILL.md.
// Mirrors the desktop launch protocol (initialize -> initialized ->
// skills/extraRoots/set -> skills/list -> thread/start -> turn/start).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { fileURLToPath } from 'node:url'
import { pinnedCodexBinary, resolveCodexHome } from './config.mjs'

const binary = process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : pinnedCodexBinary('debug')
const codexHome = resolveCodexHome()
const sharedRoot = process.env.ZERO3_SHARED_CODEX_SKILLS_ROOT?.trim() || path.join(os.homedir(), '.codex', 'skills')

if (!fs.existsSync(binary)) throw new Error(`Codex binary does not exist: ${binary}`)
if (path.resolve(codexHome) === path.resolve(os.homedir(), '.codex')) {
  throw new Error('refusing to smoke against the official ~/.codex home')
}

const child = spawn(binary, ['app-server', '--stdio', '--session-source', 'app-server'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

let stdoutBuffer = ''
let nextRequestId = 1
const pending = new Map()
let finished = false
const agentMessages = []
let chosen = null

function fail(message) {
  if (finished) return
  finished = true
  child.kill()
  console.error('SMOKE FAIL: ' + message)
  process.exit(1)
}
setTimeout(() => fail(`timed out waiting for turn completion (messages so far: ${JSON.stringify(agentMessages).slice(0, 800)})`), 300_000).unref()

function writeLine(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}
function request(method, params) {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method })
    writeLine({ id, method, params })
  })
}

child.stderr.on('data', chunk => {
  if (/error|panic/i.test(String(chunk))) console.error('[app-server stderr] ' + String(chunk).trim().slice(0, 400))
})

child.stdout.on('data', chunk => {
  stdoutBuffer += String(chunk)
  let newlineIndex
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim()
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(message.error).slice(0, 300)}`))
      else entry.resolve(message.result)
      continue
    }
    const params = message.params ?? {}
    if (message.method === 'turn/completed' && chosen && params.threadId === chosen.threadId) {
      const status = params.turn?.status
      const output = agentMessages.join('\n').trim()
      child.kill()
      finished = true
      if (status !== 'completed' || !output) {
        console.error(`SMOKE FAIL: turn status=${status}, agentMessages=${agentMessages.length}`)
        if (params.turn?.error) console.error('turn error: ' + JSON.stringify(params.turn.error).slice(0, 600))
        process.exit(1)
      }
      console.log('SMOKE PASS: Codex native skill Turn completed')
      console.log(`skill: ${chosen.name} (${chosen.scope}) -> ${chosen.path}`)
      console.log('--- agent output ---')
      console.log(output.slice(0, 2_000))
      process.exit(0)
    }
    const item = params.item
    if (message.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
      agentMessages.push(item.text)
    }
    if (message.method === 'error') {
      console.error('[app-server error event] ' + JSON.stringify(params).slice(0, 500))
    }
  }
})
child.on('exit', code => fail(`app-server exited early (code=${code})`))

const initialization = await request('initialize', {
  clientInfo: { name: 'zero3_pilot', title: 'Zero3 Pilot', version: 'smoke' },
  capabilities: { experimentalApi: true }
})
writeLine({ method: 'initialized' })
if (!initialization) fail('empty initialize result')

if (fs.existsSync(sharedRoot)) {
  await request('skills/extraRoots/set', { extraRoots: [sharedRoot] })
}

const listing = await request('skills/list', { cwds: [], forceReload: true })
const rows = []
for (const entry of Array.isArray(listing?.data) ? listing.data : []) {
  for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
    if (skill?.enabled === false) continue
    if (typeof skill?.name !== 'string' || typeof skill?.path !== 'string') continue
    if (skill.name === 'skill-installer') continue
    let size = Number.MAX_SAFE_INTEGER
    try { size = fs.statSync(skill.path).size } catch {}
    rows.push({ name: skill.name, path: skill.path, scope: skill.scope, description: String(skill.description ?? ''), size })
  }
}
if (!rows.length) fail('no enabled skills in the catalog')
rows.sort((a, b) => a.size - b.size)
const smallest = rows[0]
const descriptionLine = (() => {
  const match = /^description:\s*(.+)$/m.exec(fs.readFileSync(smallest.path, 'utf8'))
  return match ? match[1].trim().slice(0, 200) : null
})()
if (!descriptionLine) fail(`cannot read description frontmatter from ${smallest.path}`)

const threadResponse = await request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
const threadId = threadResponse?.thread?.id
if (!threadId) fail('thread/start returned no thread id')

chosen = { threadId, name: smallest.name, path: smallest.path, scope: smallest.scope }
console.log(`catalog skills: ${rows.length}; invoking smallest: ${smallest.name} (${smallest.size} bytes)`)
await request('turn/start', {
  threadId,
  input: [
    { type: 'skill', name: smallest.name, path: smallest.path },
    { type: 'text', text: 'Do not execute any command. Read the referenced SKILL.md and reply with exactly two lines: first its frontmatter description value verbatim, then the word DONE.' }
  ]
})
