import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'


const skillRuntimeSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'skill-runtime')
const skillRuntimeTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'skills')
const skillRuntimeFiles = ['skill-types.ts', 'skill-binding-store.ts', 'skill-router.ts', 'skill-catalog.ts', 'skill-usage-ledger.ts', 'index.ts']

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

async function zero3InstallNativeSkill(value: unknown) {
  const request = zero3CodexSkillInstallParams(value)
  const listing = await zero3CodexAppServer.request('skills/list', { cwds: request.cwd ? [request.cwd] : [], forceReload: true })
  const installer = zero3CodexSkillRows(listing).find(skill => skill.name === 'skill-installer' && typeof skill.path === 'string')
  if (!installer || typeof installer.path !== 'string') throw new Error('Codex native skill-installer is unavailable')
  const threadResponse = zero3CodexRecord(await zero3CodexAppServer.request('thread/start', {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    ephemeral: false
  }))
  const thread = zero3CodexRecord(threadResponse.thread)
  const threadId = zero3CodexRequiredString(thread.id, 'skill installer thread id', 256)
  const prompt = 'Install the Codex Skill from this source into the normal user Codex skills directory. Use the native skill-installer workflow and do not create a Zero3-specific copy or registry. Source: ' + request.source
  const turn = await zero3CodexAppServer.request('turn/start', {
    threadId,
    input: [
      { type: 'skill', name: 'skill-installer', path: installer.path },
      { type: 'text', text: prompt, text_elements: [] }
    ]
  }, ZERO3_CODEX_TURN_TIMEOUT_MS)
  return { threadId, source: request.source, turn }
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
type Zero3CodexSkillInstallResponse = { threadId: string; source: string; turn: unknown }
`

export function applyZero3CodexSkills() {
  stageSkillRuntime()
  patchFile('electron/main.ts', [
    {
      label: 'Skill runtime import',
      from: "import { classifyActiveRuntime } from './active-runtime-state'",
      to: "import { Zero3SkillBindingStore, Zero3SkillRouter, Zero3SkillUsageLedger, zero3NativeSkillCatalog, renderZero3SkillContext } from './zero3/skills/index'\nimport { classifyActiveRuntime } from './active-runtime-state'"
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
    }
  ])

  console.log('Codex native Skills: shared ~/.codex/skills mounted via skills/extraRoots/set; list/config/install stay app-server authoritative.')
  console.log('Codex native Skills: Turn input accepts the upstream skill item; Zero3 maintains no parallel Skill registry or installer.')
}
