import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'


const skillRuntimeSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'skill-runtime')
const skillRuntimeTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'skills')
const skillRuntimeFiles = ['skill-types.ts', 'skill-binding-store.ts', 'skill-install-jobs.ts', 'skill-router.ts', 'skill-catalog.ts', 'skill-usage-ledger.ts', 'index.ts']

function stageSkillRuntime() {
  fs.mkdirSync(skillRuntimeTargetDir, { recursive: true })
  for (const file of skillRuntimeFiles) {
    const source = path.join(skillRuntimeSourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Skill runtime source missing: ${source}`)
    fs.writeFileSync(path.join(skillRuntimeTargetDir, file), overlayRuntimeSource(fs.readFileSync(source, 'utf8')))
  }
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')
  for (const replacement of replacements) {
    if (replacement.appliedMarkers?.every(marker => source.includes(marker))) continue
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 Codex native Skills drift in ${relativePath}: could not find ${replacement.label}. Review the pinned Codex/Hermes boundary before updating the pin.`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  fs.writeFileSync(file, source)
}

const mainSkillHelpers = String.raw`
function zero3CodexSkillsListParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const rawCwds = input.cwds == null ? [] : input.cwds
  if (!Array.isArray(rawCwds) || rawCwds.length > 32) throw new Error('skills/list cwds must be an array with at most 32 items')
  return {
    cwds: rawCwds.map((cwd, index) => zero3CodexRequiredString(cwd, 'cwds[' + String(index) + ']', 4096)),
    forceReload: zero3CodexOptionalBoolean(input.forceReload, 'forceReload') ?? false
  }
}

function zero3CodexSkillsConfigWriteParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const skillPath = zero3CodexOptionalString(input.path, 'path', 4096)
  const name = zero3CodexOptionalString(input.name, 'name', 256)
  if ((skillPath ? 1 : 0) + (name ? 1 : 0) !== 1) throw new Error('skills/config/write requires exactly one of path or name')
  const enabled = zero3CodexOptionalBoolean(input.enabled, 'enabled')
  if (enabled == null) throw new Error('enabled is required')
  return { ...(skillPath ? { path: skillPath } : { name }), enabled }
}

function zero3CodexSharedSkillRoot(): string | null {
  const configured = process.env.ZERO3_SHARED_CODEX_SKILLS_ROOT?.trim()
  if (configured) return path.resolve(configured)
  const isolatedHome = process.env.CODEX_HOME?.trim()
  const officialHome = path.join(os.homedir(), '.codex')
  if (!isolatedHome || path.resolve(isolatedHome) === path.resolve(officialHome)) return null
  return path.join(officialHome, 'skills')
}

async function zero3ReadNativeSkill(value: unknown) {
  const input = zero3CodexRecord(value)
  const skillPath = zero3CodexRequiredString(input.path, 'path', 4096)
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const listing = zero3CodexRecord(await zero3CodexAppServer.request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false }))
  const skill = zero3CodexSkillRows(listing).find(row => row.path === skillPath)
  if (!skill) throw new Error('Skill path is not present in the current Codex native catalog')
  const stat = fs.statSync(skillPath)
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Skill document is unavailable or exceeds 256 KiB')
  return {
    name: typeof skill.name === 'string' ? skill.name : '',
    path: skillPath,
    content: fs.readFileSync(skillPath, 'utf8'),
    modifiedAt: stat.mtime.toISOString()
  }
}

function zero3CodexSkillInstallParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    source: zero3CodexRequiredString(input.source, 'source', 4096),
    cwd: zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  }
}

function zero3CodexSkillRows(value: unknown): Array<Record<string, unknown>> {
  const payload = zero3CodexRecord(value)
  const rows: Array<Record<string, unknown>> = []
  for (const rawEntry of Array.isArray(payload.data) ? payload.data : []) {
    const entry = zero3CodexRecord(rawEntry)
    for (const rawSkill of Array.isArray(entry.skills) ? entry.skills : []) rows.push(zero3CodexRecord(rawSkill))
  }
  return rows
}

// Installer task tracking. The Codex Turn owns the actual approvals; Zero3
// keeps only the install task envelope on disk and mirrors the live approval
// requests so a renderer reload can re-attach and an app restart can surface
// the interrupted install. No Skill files or bodies are copied or stored here.
const zero3SkillInstallJobStore = new Zero3SkillInstallJobStore(path.join(app.getPath('userData'), 'zero3', 'skill-installer-jobs.json'))
void zero3SkillInstallJobStore.recoverInterrupted().catch(() => undefined)
const zero3SkillInstallApprovals = new Map<string, { id: Zero3CodexRpcId; method: string; params: unknown }>()
let zero3SkillInstallThreadId: string | null = null
function zero3SkillInstallForget() {
  zero3SkillInstallThreadId = null
  zero3SkillInstallApprovals.clear()
}
function zero3SkillInstallRecordEvent(event: Zero3CodexEvent) {
  if (event.kind === 'lifecycle') {
    if ((event.state === 'stopped' || event.state === 'error') && zero3SkillInstallThreadId) {
      const threadId = zero3SkillInstallThreadId
      zero3SkillInstallForget()
      void zero3SkillInstallJobStore.update(threadId, { status: 'needs_recovery', error: 'Codex app-server 已停止，安装任务无法继续。' }).catch(() => undefined)
    }
    return
  }
  if (!zero3SkillInstallThreadId) return
  const params = event.params && typeof event.params === 'object' && !Array.isArray(event.params) ? event.params as Record<string, unknown> : null
  if (event.kind === 'request') {
    if (typeof params?.threadId !== 'string' || params.threadId !== zero3SkillInstallThreadId) return
    zero3SkillInstallApprovals.set(zero3CodexIdKey(event.id), { id: event.id, method: event.method, params: event.params })
    return
  }
  if (event.method === 'serverRequest/resolved') {
    const requestId = params?.requestId
    if (typeof requestId === 'string' || typeof requestId === 'number') zero3SkillInstallApprovals.delete(zero3CodexIdKey(requestId))
    return
  }
  if (event.method === 'turn/completed' && params?.threadId === zero3SkillInstallThreadId) {
    const threadId = zero3SkillInstallThreadId
    zero3SkillInstallForget()
    const turn = zero3CodexRecord(params?.turn)
    const error = zero3CodexRecord(turn.error).message
    void zero3SkillInstallJobStore.update(threadId, {
      status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed',
      error: typeof error === 'string' ? error : null
    }).catch(() => undefined)
  }
}
async function zero3PendingSkillInstallState() {
  const jobs = await zero3SkillInstallJobStore.list()
  const activeJob = zero3SkillInstallThreadId ? jobs.find(job => job.threadId === zero3SkillInstallThreadId) ?? null : null
  return {
    activeJob,
    recoverableJobs: jobs.filter(job => job.status === 'needs_recovery'),
    approvals: activeJob ? [...zero3SkillInstallApprovals.values()] : []
  }
}
async function zero3DismissSkillInstallJob(value: unknown) {
  const threadId = zero3CodexRequiredString(zero3CodexRecord(value).threadId, 'threadId', 256)
  return { removed: await zero3SkillInstallJobStore.remove(threadId) }
}

async function zero3InstallNativeSkill(value: unknown) {
  const request = zero3CodexSkillInstallParams(value)
  const listing = await zero3CodexAppServer.request('skills/list', { cwds: request.cwd ? [request.cwd] : [], forceReload: true })
  const installer = zero3CodexSkillRows(listing).find(skill => skill.name === 'skill-installer' && skill.scope === 'system' && skill.enabled !== false && typeof skill.path === 'string')
  if (!installer || typeof installer.path !== 'string') throw new Error('Codex native skill-installer is unavailable')
  const threadResponse = zero3CodexRecord(await zero3CodexAppServer.request('thread/start', {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    ephemeral: false
  }))
  const thread = zero3CodexRecord(threadResponse.thread)
  const threadId = zero3CodexRequiredString(thread.id, 'skill installer thread id', 256)
  const destination = zero3CodexSharedSkillRoot() ?? path.join(os.homedir(), '.codex', 'skills')
  zero3SkillInstallThreadId = threadId
  zero3SkillInstallApprovals.clear()
  await zero3SkillInstallJobStore.record({ threadId, source: request.source, cwd: request.cwd ?? null, destination })
  const prompt = 'Install the Codex Skill using the native skill-installer workflow. Pass --dest ' + JSON.stringify(destination) + ' explicitly to its install script; CODEX_HOME belongs to the isolated Zero3 kernel and is not the installation destination. Do not create a Zero3-specific copy or registry. Report the installed Skill path or the concrete failure. Source: ' + request.source
  try {
    const turn = await zero3CodexAppServer.request('turn/start', {
      threadId,
      input: [
        { type: 'skill', name: 'skill-installer', path: installer.path },
        { type: 'text', text: prompt, text_elements: [] }
      ]
    }, ZERO3_CODEX_TURN_TIMEOUT_MS)
    const status = zero3CodexRecord(zero3CodexRecord(turn).turn).status
    if (status === 'completed' || status === 'interrupted' || status === 'failed') {
      zero3SkillInstallForget()
      await zero3SkillInstallJobStore.update(threadId, { status }).catch(() => undefined)
    }
    return { threadId, source: request.source, destination, turn }
  } catch (error) {
    zero3SkillInstallForget()
    await zero3SkillInstallJobStore.update(threadId, { status: 'failed', error: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
    throw error
  }
}
`

const preloadSkills = String.raw`  skills: {
    list: request => ipcRenderer.invoke('zero3:codex:skills:list', request),
    setEnabled: request => ipcRenderer.invoke('zero3:codex:skills:set-enabled', request),
    install: request => ipcRenderer.invoke('zero3:codex:skills:install', request),
    read: request => ipcRenderer.invoke('zero3:codex:skills:read', request),
    bindings: {
      list: () => ipcRenderer.invoke('zero3:codex:skills:bindings:list'),
      upsert: request => ipcRenderer.invoke('zero3:codex:skills:bindings:upsert', request),
      remove: request => ipcRenderer.invoke('zero3:codex:skills:bindings:remove', request)
    }
  },
  ollama: {`

const windowSkillTypes = String.raw`      skills: {
        list: (request?: Zero3CodexSkillsListRequest) => Promise<Zero3CodexSkillsListResponse>
        setEnabled: (request: Zero3CodexSkillConfigRequest) => Promise<{ effectiveEnabled: boolean }>
        install: (request: Zero3CodexSkillInstallRequest) => Promise<Zero3CodexSkillInstallResponse>
        read: (request: { path: string; cwd?: string }) => Promise<{ name: string; path: string; content: string; modifiedAt: string }>
        bindings: {
          list: () => Promise<Zero3SkillBinding[]>
          upsert: (request: Zero3SkillBindingInput) => Promise<Zero3SkillBinding>
          remove: (request: { bindingId: string }) => Promise<{ removed: boolean }>
        }
      }
      ollama: {`

const skillTypeDefinitions = String.raw`type Zero3CodexSkillMetadata = {
  name: string
  description: string
  shortDescription?: string
  path: string
  scope: 'user' | 'repo' | 'system' | 'admin'
  enabled: boolean
  pluginId?: string | null
  interface?: {
    displayName?: string | null
    shortDescription?: string | null
    defaultPrompt?: string | null
  } | null
}

type Zero3CodexSkillsListRequest = { cwds?: string[]; forceReload?: boolean }
type Zero3CodexSkillsListResponse = { data: Array<{ cwd: string; skills: Zero3CodexSkillMetadata[]; errors: Array<{ path: string; message: string }> }> }
type Zero3CodexSkillConfigRequest = { path?: string; name?: string; enabled: boolean }
type Zero3CodexSkillInstallRequest = { source: string; cwd?: string }
type Zero3CodexSkillInstallResponse = { threadId: string; source: string; destination: string; turn: unknown }
`

export function applyZero3CodexSkills() {
  stageSkillRuntime()
  // Prepared desktops may already contain an older version of this overlay.
  // Replace the owned helper block before the general insert-if-missing patches
  // so an upgrade cannot silently add duplicate function/type declarations.
  const mainFile = path.join(hermesDesktopDir, 'electron', 'main.ts')
  let mainSource = fs.readFileSync(mainFile, 'utf8')
  const helperStart = mainSource.indexOf('\nfunction zero3CodexSkillsListParams(')
  if (helperStart >= 0) {
    const helperEnd = mainSource.indexOf('\nfunction zero3CodexThreadStartParams(', helperStart)
    if (helperEnd < 0) throw new Error('Zero3 Codex native Skills drift: missing end of owned helper block')
    mainSource = mainSource.slice(0, helperStart) + mainSkillHelpers + mainSource.slice(helperEnd)
    fs.writeFileSync(mainFile, mainSource)
  }
  const typesFile = path.join(hermesDesktopDir, 'src', 'global.d.ts')
  fs.writeFileSync(typesFile, fs.readFileSync(typesFile, 'utf8').replace(
    'type Zero3CodexSkillInstallResponse = { threadId: string; source: string; turn: unknown }',
    'type Zero3CodexSkillInstallResponse = { threadId: string; source: string; destination: string; turn: unknown }'
  ))
  patchFile('electron/main.ts', [
    {
      label: 'Skill runtime import',
      appliedMarkers: ["renderZero3SkillContext } from './zero3/skills/index'"],
      from: "import { classifyActiveRuntime } from './active-runtime-state'",
      to: "import { Zero3SkillBindingStore, Zero3SkillRouter, Zero3SkillUsageLedger, zero3NativeSkillCatalog, renderZero3SkillContext, Zero3SkillInstallJobStore } from './zero3/skills/index'\nimport { classifyActiveRuntime } from './active-runtime-state'"
    },
    {
      label: 'Skill install job store import on prepared desktops',
      from: "renderZero3SkillContext } from './zero3/skills/index'",
      to: "renderZero3SkillContext, Zero3SkillInstallJobStore } from './zero3/skills/index'"
    },
    {
      label: 'skill install approval tracking hook',
      from: '  private emit(event: Zero3CodexEvent) {\n    for (const listener of this.listeners) {',
      to: '  private emit(event: Zero3CodexEvent) {\n    zero3SkillInstallRecordEvent(event)\n    for (const listener of this.listeners) {'
    },
    {
      label: 'skill install approval response hook',
      from: '    this.serverRequests.delete(key)\n    this.writeLine(response)',
      to: '    this.serverRequests.delete(key)\n    zero3SkillInstallApprovals.delete(key)\n    this.writeLine(response)'
    },
    {
      label: 'native Skill helpers before thread params',
      from: 'function zero3CodexThreadStartParams(value: unknown) {',
      to: mainSkillHelpers + '\nfunction zero3CodexThreadStartParams(value: unknown) {'
    },
    {
      label: 'shared official Codex Skill root after app-server initialization',
      from: "      this.writeLine({ method: 'initialized' })\n      this.emit({ kind: 'lifecycle', state: 'started' })",
      to: "      this.writeLine({ method: 'initialized' })\n      const zero3SharedSkillRoot = zero3CodexSharedSkillRoot()\n      if (zero3SharedSkillRoot) {\n        await this.requestStarted('skills/extraRoots/set', { extraRoots: [zero3SharedSkillRoot] }, ZERO3_CODEX_REQUEST_TIMEOUT_MS)\n      }\n      this.emit({ kind: 'lifecycle', state: 'started' })"
    },
    {
      label: 'Skill relation and usage stores',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: "const zero3SkillBindingStore = new Zero3SkillBindingStore(path.join(app.getPath('userData'), 'zero3', 'skill-bindings.json'))\nconst zero3SkillRouter = new Zero3SkillRouter()\nconst zero3SkillUsageLedger = new Zero3SkillUsageLedger(path.join(app.getPath('userData'), 'zero3', 'skill-usage.jsonl'))\nconst zero3CodexAppServer = createZero3CodexAppServer()"
    },
    {
      label: 'native Skill IPC handlers',
      from: "ipcMain.handle('zero3:ollama:list-models', () => zero3ListOllamaModels())",
      to: "ipcMain.handle('zero3:ollama:list-models', () => zero3ListOllamaModels())\nipcMain.handle('zero3:codex:skills:list', (_event, request: unknown) => zero3CodexAppServer.request('skills/list', zero3CodexSkillsListParams(request)))\nipcMain.handle('zero3:codex:skills:set-enabled', (_event, request: unknown) => zero3CodexAppServer.request('skills/config/write', zero3CodexSkillsConfigWriteParams(request)))\nipcMain.handle('zero3:codex:skills:install', (_event, request: unknown) => zero3InstallNativeSkill(request))\nipcMain.handle('zero3:codex:skills:read', (_event, request: unknown) => zero3ReadNativeSkill(request))\nipcMain.handle('zero3:codex:skills:bindings:list', () => zero3SkillBindingStore.list())\nipcMain.handle('zero3:codex:skills:bindings:upsert', (_event, request: never) => zero3SkillBindingStore.upsert(request))\nipcMain.handle('zero3:codex:skills:bindings:remove', async (_event, request: unknown) => { const input = zero3CodexRecord(request); return { removed: await zero3SkillBindingStore.remove(input.bindingId) } })"
    },
    {
      label: 'skill install pending IPC handlers',
      from: "ipcMain.handle('zero3:codex:skills:install', (_event, request: unknown) => zero3InstallNativeSkill(request))",
      to: "ipcMain.handle('zero3:codex:skills:install', (_event, request: unknown) => zero3InstallNativeSkill(request))\nipcMain.handle('zero3:codex:skills:install:pending', () => zero3PendingSkillInstallState())\nipcMain.handle('zero3:codex:skills:install:dismiss', (_event, request: unknown) => zero3DismissSkillInstallJob(request))"
    }
  ])

  patchFile('electron/main.ts', [
    {
      label: 'native skill Turn input before localImage input',
      from: String.raw`  if (type === 'localImage') {
    return {
      type: 'localImage',
      path: zero3CodexRequiredString(input.path, 'input[' + String(index) + '].path', 4096)
    }
  }`,
      to: String.raw`  if (type === 'skill') {
    return {
      type: 'skill',
      name: zero3CodexRequiredString(input.name, 'input[' + String(index) + '].name', 256),
      path: zero3CodexRequiredString(input.path, 'input[' + String(index) + '].path', 4096)
    }
  }

  if (type === 'localImage') {
    return {
      type: 'localImage',
      path: zero3CodexRequiredString(input.path, 'input[' + String(index) + '].path', 4096)
    }
  }`
    },
    {
      label: 'native skill Turn input validation message',
      from: "throw new Error('input[' + String(index) + '].type must be text or localImage')",
      to: "throw new Error('input[' + String(index) + '].type must be text, skill, or localImage')"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'native Skills preload surface',
      from: '  ollama: {',
      to: preloadSkills
    },
    {
      label: 'skill install recovery preload surface',
      from: "    install: request => ipcRenderer.invoke('zero3:codex:skills:install', request),",
      to: "    install: request => ipcRenderer.invoke('zero3:codex:skills:install', request),\n    pending: () => ipcRenderer.invoke('zero3:codex:skills:install:pending'),\n    dismissInstallJob: request => ipcRenderer.invoke('zero3:codex:skills:install:dismiss', request),"
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'native Skills renderer surface',
      from: '      ollama: {',
      to: windowSkillTypes
    },
    {
      label: 'native Skills type declarations',
      from: "type Zero3OllamaModel = {",
      to: skillTypeDefinitions + String.raw`
type Zero3SkillBindingTargetType = 'agent' | 'workflow' | 'task-template'
type Zero3SkillBinding = {
  bindingId: string
  targetType: Zero3SkillBindingTargetType
  targetId: string
  skillName: string
  skillPath: string
  enabled: boolean
  autoInvoke: boolean
  priority: number
  createdAt: string
  updatedAt: string
}
type Zero3SkillBindingInput = Omit<Zero3SkillBinding, 'bindingId' | 'createdAt' | 'updatedAt'> & { bindingId?: string }

type Zero3OllamaModel = {`
    },
    {
      label: 'native skill structured Turn input type',
      from: String.raw`type Zero3CodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }`,
      to: String.raw`type Zero3CodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'localImage'; path: string }`
    },
    {
      label: 'skill install recovery renderer surface',
      from: '        install: (request: Zero3CodexSkillInstallRequest) => Promise<Zero3CodexSkillInstallResponse>',
      to: '        install: (request: Zero3CodexSkillInstallRequest) => Promise<Zero3CodexSkillInstallResponse>\n        pending: () => Promise<Zero3SkillInstallPendingState>\n        dismissInstallJob: (request: { threadId: string }) => Promise<{ removed: boolean }>'
    },
    {
      label: 'skill install recovery type declarations',
      from: 'type Zero3CodexSkillInstallResponse = { threadId: string; source: string; destination: string; turn: unknown }',
      to: String.raw`type Zero3CodexSkillInstallResponse = { threadId: string; source: string; destination: string; turn: unknown }

type Zero3SkillInstallJobStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'needs_recovery'
type Zero3SkillInstallJob = {
  threadId: string
  source: string
  cwd: string | null
  destination: string
  status: Zero3SkillInstallJobStatus
  startedAt: string
  updatedAt: string
  endedAt: string | null
  error: string | null
}
type Zero3SkillInstallPendingState = {
  activeJob: Zero3SkillInstallJob | null
  recoverableJobs: Zero3SkillInstallJob[]
  approvals: Array<{ id: string | number; method: string; params: unknown }>
}`
    }
  ])

  console.log('Codex native Skills: shared ~/.codex/skills mounted via skills/extraRoots/set; list/config/install stay app-server authoritative.')
  console.log('Codex native Skills: Turn input accepts the upstream skill item; Zero3 maintains no parallel Skill registry or installer.')
  console.log('Codex native Skills: installer tasks persist across renderer reloads; interrupted installs surface a recovery prompt after restart.')
}
