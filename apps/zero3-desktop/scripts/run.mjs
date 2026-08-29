import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import {
  commandName,
  hermesRoot,
  repoRoot,
  resolveHermesHome
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

function ensureHermesDependencies(env) {
  if (isDirectory(path.join(hermesRoot, 'node_modules'))) return
  runSync(commandName('npm'), ['install', '--workspace', 'apps/desktop'], {
    cwd: hermesRoot,
    env
  })
}

function hermesVenvPython() {
  return path.join(
    hermesRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
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
  throw new Error('A supported Python interpreter is required for the temporary Hermes UI compatibility backend.')
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
    throw new Error(`Hermes UI compatibility dependencies were not importable after installation in ${venvPython}`)
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
  ZERO3_DESKTOP_CORE: 'codex-app-server',
  ZERO3_DESKTOP_SHELL: 'hermes-ui-compat'
}

ensureHermesDependencies(env)

// R0 migration note: upstream Hermes Desktop still expects its own backend to
// boot the existing shell. Keep that backend only as temporary UI scaffolding.
// The target Zero3 runtime is Codex app-server and no Zero3 product capability
// may be added to this compatibility backend.
if (mode === 'dev') {
  console.warn('[Zero3 R0] Hermes backend is UI compatibility scaffolding only; Codex remains the target core runtime.')
  ensureHermesPythonDependencies(env)
}

// Deliberately do NOT start zero3-pilot-node here. R0 breaks the previous
// Hermes UI -> Zero3 Node -> worker architecture. R1 will own Codex app-server
// lifecycle and transport directly from the desktop shell.
await runHermesDesktop(mode, env)
