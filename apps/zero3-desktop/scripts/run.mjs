import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import {
  codexRoot,
  commandName,
  hermesDesktopDir,
  hermesRoot,
  pinnedCodexBinary,
  repoRoot,
  resolveCodexHome,
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

function hermesNodePackageExists(...segments) {
  return (
    isFile(path.join(hermesDesktopDir, 'node_modules', ...segments, 'package.json')) ||
    isFile(path.join(hermesRoot, 'node_modules', ...segments, 'package.json'))
  )
}

function ensureHermesDependencies(env) {
  const nodeModulesPresent = isDirectory(path.join(hermesRoot, 'node_modules'))
  const zero3McpDependenciesPresent =
    hermesNodePackageExists('@modelcontextprotocol', 'server') && hermesNodePackageExists('zod')
  if (nodeModulesPresent && zero3McpDependenciesPresent) return
  runSync(commandName('npm'), ['install', '--workspace', 'apps/desktop'], {
    cwd: hermesRoot,
    env
  })
  if (
    !hermesNodePackageExists('@modelcontextprotocol', 'server') ||
    !hermesNodePackageExists('zod')
  ) {
    throw new Error('Zero3 project-context MCP dependencies were not installed into the Hermes desktop workspace.')
  }
}

function ensurePinnedCodexBinary(env, profile = 'debug') {
  const binary = pinnedCodexBinary(profile)
  if (isFile(binary)) return binary

  console.log(`[Zero3] Building pinned open-source Codex core (${profile})...`)
  const args = [
    'build',
    '--manifest-path',
    path.join(codexRoot, 'codex-rs', 'Cargo.toml'),
    '-p',
    'codex-cli',
    '--bin',
    'codex'
  ]
  if (profile === 'release') args.push('--release')
  runSync('cargo', args, { cwd: codexRoot, env })

  if (!isFile(binary)) {
    throw new Error(`Pinned Codex binary was not produced at ${binary}`)
  }
  return binary
}

function copyRequiredFile(source, target) {
  if (!isFile(source)) throw new Error(`Required release file is missing: ${source}`)
  fs.copyFileSync(source, target)
  if (!isFile(target) || fs.statSync(target).size === 0) {
    throw new Error(`Failed to stage release file: ${target}`)
  }
}

function stagePinnedCodexForWindowsPackage(binary) {
  if (process.platform !== 'win32') {
    throw new Error('dist:win must run on Windows so the packaged Codex binary matches the target platform.')
  }

  const codexTargetDir = path.join(hermesDesktopDir, 'build', 'zero3-codex')
  const codexTarget = path.join(codexTargetDir, 'codex.exe')
  fs.rmSync(codexTargetDir, { recursive: true, force: true })
  fs.mkdirSync(codexTargetDir, { recursive: true })
  copyRequiredFile(binary, codexTarget)

  const legalTargetDir = path.join(hermesDesktopDir, 'build', 'zero3-legal')
  fs.rmSync(legalTargetDir, { recursive: true, force: true })
  fs.mkdirSync(legalTargetDir, { recursive: true })
  copyRequiredFile(path.join(repoRoot, 'LICENSE'), path.join(legalTargetDir, 'LICENSE-Zero3-Pilot.txt'))
  copyRequiredFile(path.join(repoRoot, 'NOTICE'), path.join(legalTargetDir, 'NOTICE-Zero3-Pilot.txt'))
  copyRequiredFile(path.join(codexRoot, 'LICENSE'), path.join(legalTargetDir, 'LICENSE-OpenAI-Codex.txt'))
  copyRequiredFile(path.join(codexRoot, 'NOTICE'), path.join(legalTargetDir, 'NOTICE-OpenAI-Codex.txt'))
  copyRequiredFile(path.join(hermesRoot, 'LICENSE'), path.join(legalTargetDir, 'LICENSE-Hermes-Agent.txt'))

  console.log(`[Zero3] Staged pinned Codex release binary for Windows package: ${codexTarget}`)
  console.log(`[Zero3] Staged Zero3/Codex/Hermes release notices: ${legalTargetDir}`)
  return codexTarget
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

const externallyPrepared = ['1', 'true', 'yes', 'on'].includes(
  (process.env.ZERO3_DESKTOP_ALREADY_PREPARED ?? '').trim().toLowerCase()
)
if (!externallyPrepared) {
  runSync(process.execPath, [path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'prepare-upstream.mjs')])
  runSync(process.execPath, [path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'prepare-gemini-integration.mjs')])
  runSync(process.execPath, [path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'prepare-codex-upstream.mjs')])
}

const hermesHome = resolveHermesHome()
const codexHome = resolveCodexHome()
fs.mkdirSync(hermesHome, { recursive: true })
fs.mkdirSync(codexHome, { recursive: true })

const baseEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  HERMES_HOME: hermesHome,
  HERMES_DESKTOP_HERMES_ROOT: hermesRoot,
  HERMES_DESKTOP_APP_NAME: 'Zero3 Pilot',
  ZERO3_CODEX_CWD: repoRoot,
  ZERO3_DESKTOP_CORE: 'codex-app-server',
  ZERO3_DESKTOP_SHELL: 'hermes-ui-compat'
}

let codexBinary
if (mode === 'dev') {
  codexBinary = ensurePinnedCodexBinary(baseEnv, 'debug')
} else if (mode === 'dist:win') {
  codexBinary = ensurePinnedCodexBinary(baseEnv, 'release')
  stagePinnedCodexForWindowsPackage(codexBinary)
  runSync(process.execPath, [path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'prepare-windows-package.mjs')])
} else {
  codexBinary = pinnedCodexBinary('debug')
}

const env = {
  ...baseEnv,
  // Development/build orchestration points only at the binary built from the
  // reviewed upstream/codex pin. The packaged Windows app has a separate
  // fail-closed resolver for its bundled resources/zero3-codex/codex.exe.
  ZERO3_CODEX_BIN: codexBinary
}

ensureHermesDependencies(env)

// Hermes still boots its backend only so the unported UI can render. No Zero3
// capability may depend on it. R1A Codex IPC is independent and talks directly
// to the pinned Codex app-server child owned by Electron main.
if (mode === 'dev') {
  console.warn('[Zero3 R1A] Hermes backend remains temporary UI compatibility scaffolding.')
  ensureHermesPythonDependencies(env)
  console.log(`[Zero3 R1A] Codex core binary: ${env.ZERO3_CODEX_BIN}`)
  console.log(`[Zero3 R1A] Isolated Codex home: ${codexHome}`)
}

// Deliberately do NOT start zero3-pilot-node. Electron starts Codex app-server
// lazily through the typed zero3Codex preload surface.
await runHermesDesktop(mode, env)
