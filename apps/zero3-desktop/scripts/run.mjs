import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import {
  commandName,
  hermesRoot,
  repoRoot,
  resolveHermesHome,
  zero3NodeBinary,
  zero3Port
} from './config.mjs'

const mode = process.argv[2] ?? 'dev'
const allowedModes = new Set(['dev', 'typecheck', 'dist:win'])
if (!allowedModes.has(mode)) {
  throw new Error(`Unsupported Zero3 Desktop mode: ${mode}`)
}

function runSync(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited with status ${result.status}`)
  }
}

async function nodeHealthy() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600)
  try {
    const response = await fetch(`http://127.0.0.1:${zero3Port}/health`, {
      signal: controller.signal
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function ensureZero3Node() {
  if (await nodeHealthy()) return null

  const binary = zero3NodeBinary()
  if (!fs.isFileSync(binary)) {
    runSync('cargo', ['build', '-p', 'zero3-node'])
  }
  if (!fs.isFileSync(binary)) {
    throw new Error(`Zero3 Node binary was not produced at ${binary}`)
  }

  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ZERO3_PILOT_NODE_PORT: String(zero3Port)
    },
    stdio: 'inherit',
    windowsHide: true
  })

  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await nodeHealthy()) return child
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  child.kill()
  throw new Error(`Zero3 Node did not become healthy on 127.0.0.1:${zero3Port}`)
}

function ensureHermesDependencies(env) {
  if (fs.isDirectory(path.join(hermesRoot, 'node_modules'))) return
  runSync(commandName('npm'), ['install'], { cwd: hermesRoot, env })
}

function runHermesDesktop(script, env) {
  const child = spawn(commandName('npm'), ['--workspace', 'apps/desktop', 'run', script], {
    cwd: hermesRoot,
    env,
    stdio: 'inherit',
    shell: false
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Hermes Desktop ${script} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`))
    })
  })
}

runSync(process.execPath, [path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'prepare-upstream.mjs')])

const hermesHome = resolveHermesHome()
fs.mkdirSync(hermesHome, { recursive: true })
const env = {
  ...process.env,
  HERMES_HOME: hermesHome,
  HERMES_DESKTOP_HERMES_ROOT: hermesRoot,
  ZERO3_PILOT_NODE_PORT: String(zero3Port),
  ZERO3_DESKTOP_SHELL: 'hermes'
}

ensureHermesDependencies(env)

let ownedNode = null
try {
  if (mode === 'dev') ownedNode = await ensureZero3Node()
  await runHermesDesktop(mode, env)
} finally {
  if (ownedNode && !ownedNode.killed) ownedNode.kill()
}
