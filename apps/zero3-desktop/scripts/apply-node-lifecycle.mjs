import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Node lifecycle drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes Desktop source and preceding Zero3 overlays before updating.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3NodeLifecycle() {
  const packagePath = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  packageJson.build = packageJson.build ?? {}

  if (process.platform === 'win32') {
    const resources = Array.isArray(packageJson.build.extraResources) ? packageJson.build.extraResources : []
    const withoutZero3Node = resources.filter(resource => resource?.to !== 'zero3/zero3-pilot-node.exe')
    packageJson.build.extraResources = [
      ...withoutZero3Node,
      {
        from: 'build/zero3/zero3-pilot-node.exe',
        to: 'zero3/zero3-pilot-node.exe'
      }
    ]
  }

  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  patchFile('electron/main.ts', [
    {
      label: 'Zero3 Node owned lifecycle after endpoint constants',
      from: `const ZERO3_NODE_PORT = Number(process.env.ZERO3_PILOT_NODE_PORT ?? '8790')
const ZERO3_NODE_BASE = \`http://127.0.0.1:\${Number.isFinite(ZERO3_NODE_PORT) ? ZERO3_NODE_PORT : 8790}\`
const ZERO3_READ_ROUTES = {`,
      to: `const ZERO3_NODE_PORT = Number(process.env.ZERO3_PILOT_NODE_PORT ?? '8790')
const ZERO3_NODE_BASE = \`http://127.0.0.1:\${Number.isFinite(ZERO3_NODE_PORT) ? ZERO3_NODE_PORT : 8790}\`
const ZERO3_NODE_RUNTIME = 'zero3-pilot-node'
let zero3OwnedNode: ReturnType<typeof spawn> | null = null
let zero3NodeStartPromise: Promise<void> | null = null

function zero3PackagedNodePath(): string | null {
  const explicit = process.env.ZERO3_PILOT_NODE_BIN?.trim()
  if (explicit) return path.resolve(explicit)
  if (!app.isPackaged) return null
  const executable = process.platform === 'win32' ? 'zero3-pilot-node.exe' : 'zero3-pilot-node'
  return path.join(process.resourcesPath, 'zero3', executable)
}

function zero3ManagedHermesCliPath(): string {
  return process.platform === 'win32'
    ? path.join(VENV_ROOT, 'Scripts', 'hermes.exe')
    : path.join(VENV_ROOT, 'bin', 'hermes')
}

async function probeZero3Node(): Promise<boolean> {
  let response: Response
  try {
    response = await fetch(ZERO3_NODE_BASE + '/health', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(650)
    })
  } catch {
    return false
  }

  if (!response.ok) {
    throw new Error(\`Port \${ZERO3_NODE_PORT} is occupied by a service returning HTTP \${response.status}\`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(\`Port \${ZERO3_NODE_PORT} is occupied by a non-Zero3 service\`)
  }

  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  if (record.status !== 'ok' || record.runtime !== ZERO3_NODE_RUNTIME) {
    throw new Error(\`Port \${ZERO3_NODE_PORT} is occupied by an unexpected local service\`)
  }
  return true
}

function stopOwnedZero3Node(): void {
  const child = zero3OwnedNode
  zero3OwnedNode = null
  if (!child || child.killed || child.pid === undefined) return

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // Best effort during application shutdown.
    }
  }
}

async function startZero3Node(): Promise<void> {
  if (await probeZero3Node()) return

  const executable = zero3PackagedNodePath()
  if (!executable) {
    throw new Error('Zero3 Node is offline. Start Zero3 Desktop through apps/zero3-desktop in development.')
  }
  if (!fs.existsSync(executable)) {
    throw new Error(\`Packaged Zero3 Node is missing: \${executable}\`)
  }

  const dataDir = process.env.ZERO3_PILOT_DATA_DIR?.trim() || path.join(app.getPath('userData'), 'zero3-node')
  fs.mkdirSync(dataDir, { recursive: true })

  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      ZERO3_PILOT_NODE_PORT: String(ZERO3_NODE_PORT),
      ZERO3_PILOT_DATA_DIR: dataDir,
      ZERO3_HERMES_BIN: process.env.ZERO3_HERMES_BIN?.trim() || zero3ManagedHermesCliPath()
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  zero3OwnedNode = child

  child.stdout?.on('data', chunk => console.log('[zero3-node]', String(chunk).trimEnd()))
  child.stderr?.on('data', chunk => console.error('[zero3-node]', String(chunk).trimEnd()))
  child.once('exit', () => {
    if (zero3OwnedNode === child) zero3OwnedNode = null
  })

  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(\`Zero3 Node exited during startup with code \${child.exitCode}\`)
    }
    if (await probeZero3Node()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  stopOwnedZero3Node()
  throw new Error(\`Zero3 Node did not become healthy on 127.0.0.1:\${ZERO3_NODE_PORT}\`)
}

async function ensureZero3NodeRuntime(): Promise<void> {
  if (await probeZero3Node()) return
  if (!zero3NodeStartPromise) {
    zero3NodeStartPromise = startZero3Node().finally(() => {
      zero3NodeStartPromise = null
    })
  }
  return zero3NodeStartPromise
}

app.whenReady().then(() => {
  void ensureZero3NodeRuntime().catch(error => {
    console.error('[zero3-node] startup failed:', error)
  })

  const smokeMs = Number(process.env.ZERO3_ELECTRON_SMOKE_MS ?? '0')
  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    setTimeout(() => app.quit(), Math.max(1000, smokeMs))
  }
})

app.on('before-quit', () => {
  stopOwnedZero3Node()
})

const ZERO3_READ_ROUTES = {`
    },
    {
      label: 'ensure Zero3 Node before allowlisted reads',
      from: `async function readZero3Node(resource: Zero3ReadResource): Promise<unknown> {
  const route = ZERO3_READ_ROUTES[resource]`,
      to: `async function readZero3Node(resource: Zero3ReadResource): Promise<unknown> {
  await ensureZero3NodeRuntime()
  const route = ZERO3_READ_ROUTES[resource]`
    },
    {
      label: 'ensure Zero3 Node before Agent writes',
      from: `async function postZero3Agent(
  payload: Zero3AgentDispatchPayload,
  approved: boolean
): Promise<Response> {
  return fetch(ZERO3_NODE_BASE + '/api/v1/jobs/agent', {`,
      to: `async function postZero3Agent(
  payload: Zero3AgentDispatchPayload,
  approved: boolean
): Promise<Response> {
  await ensureZero3NodeRuntime()
  return fetch(ZERO3_NODE_BASE + '/api/v1/jobs/agent', {`
    }
  ])
}
