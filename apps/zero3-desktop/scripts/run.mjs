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

function needsShell(file) {
  return process.platform === 'win32' && file.toLowerCase().endsWith('.cmd')
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function runSync(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: options.shell ?? needsShell(file)
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
    return body?.status === 'ok' && body?.runtime === 'zero3-pilot-node'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function hermesVenvPython() {
  return path.join(
    hermesRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
}

function hermesVenvCli() {
  return path.join(
    hermesRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'hermes.exe' : 'hermes'
  )
}

function resolveHermesWorkerExecutable(env) {
  if (env.ZERO3_HERMES_BIN) return env.ZERO3_HERMES_BIN
  const bundled = hermesVenvCli()
  return isFile(bundled) ? bundled : 'hermes'
}

async function ensureZero3Node(env) {
  if (await nodeHealthy()) return null

  const binary = zero3NodeBinary()
  if (!isFile(binary)) {
    runSync('cargo', ['build', '-p', 'zero3-node'])
  }
  if (!isFile(binary)) {
    throw new Error(`Zero3 Node binary was not produced at ${binary}`)
  }

  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...env,
      ZERO3_PILOT_NODE_PORT: String(zero3Port),
      ZERO3_HERMES_BIN: resolveHermesWorkerExecutable(env)
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

function zero3ReleaseNodeBinary() {
  const executable = process.platform === 'win32' ? 'zero3-pilot-node.exe' : 'zero3-pilot-node'
  return path.join(repoRoot, 'target', 'release', executable)
}

function stageZero3NodeForElectronPackage() {
  if (process.platform !== 'win32') {
    throw new Error('Zero3 Desktop dist:win must run on Windows so the bundled Zero3 Node matches the package target.')
  }

  runSync('cargo', ['build', '--release', '-p', 'zero3-node'])
  const source = zero3ReleaseNodeBinary()
  if (!isFile(source)) {
    throw new Error(`Release Zero3 Node binary was not produced at ${source}`)
  }

  const targetDir = path.join(hermesRoot, 'apps', 'desktop', 'build', 'zero3')
  fs.mkdirSync(targetDir, { recursive: true })
  const target = path.join(targetDir, path.basename(source))
  fs.copyFileSync(source, target)
  console.log(`Staged Zero3 Node for Electron package: ${target}`)
}

function ensureHermesDependencies(env) {
  if (isDirectory(path.join(hermesRoot, 'node_modules'))) return
  runSync(commandName('npm'), ['install', '--workspace', 'apps/desktop'], {
    cwd: hermesRoot,
    env
  })
}

function pythonCanStartHermesGateway(python, env) {
  if (!isFile(python)) return false
  const probe = spawnSync(
    python,
    ['-c', 'import yaml; import dotenv; import fastapi; import uvicorn; import multipart; import hermes_cli.config'],
    {
      cwd: hermesRoot,
      env,
      stdio: 'ignore',
      shell: false
    }
  )
  return !probe.error && probe.status === 0
}

function resolveSystemPython(env) {
  const candidates = process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
      cwd: hermesRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false
    })
    if (!probe.error && probe.status === 0) return candidate
  }
  throw new Error('A supported Python interpreter is required to prepare the Hermes gateway runtime.')
}

function ensureHermesPythonDependencies(env) {
  const venvPython = hermesVenvPython()
  if (pythonCanStartHermesGateway(venvPython, env)) return

  if (!isFile(venvPython)) {
    runSync(resolveSystemPython(env), ['-m', 'venv', path.join(hermesRoot, '.venv')], {
      cwd: hermesRoot,
      env
    })
  }

  runSync(
    venvPython,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--editable', '.[web]'],
    { cwd: hermesRoot, env }
  )

  if (!pythonCanStartHermesGateway(venvPython, env)) {
    throw new Error(`Hermes gateway dependencies were not importable after installation in ${venvPython}`)
  }
}

function runHermesDesktop(script, env) {
  const command = commandName('npm')
  const child = spawn(command, ['--workspace', 'apps/desktop', 'run', script], {
    cwd: hermesRoot,
    env,
    stdio: 'inherit',
    shell: needsShell(command)
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
  HERMES_DESKTOP_APP_NAME: 'Zero3 Pilot',
  ZERO3_PILOT_NODE_PORT: String(zero3Port),
  ZERO3_DESKTOP_SHELL: 'hermes'
}

ensureHermesDependencies(env)
if (mode === 'dev') ensureHermesPythonDependencies(env)
if (mode === 'dist:win') stageZero3NodeForElectronPackage()

let ownedNode = null
try {
  if (mode === 'dev') ownedNode = await ensureZero3Node(env)
  await runHermesDesktop(mode, env)
} finally {
  if (ownedNode && !ownedNode.killed) ownedNode.kill()
}
