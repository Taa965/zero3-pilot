import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const source = path.join(repoRoot, 'apps', 'zero3-desktop', 'mcp-runtime', 'project-context-server.mjs')
const target = path.join(hermesDesktopDir, 'electron', 'zero3', 'mcp', 'project-context-server.mjs')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let content = read(file)
  for (const replacement of replacements) {
    if (content.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!content.includes(replacement.from)) {
      throw new Error(`Zero3 project-context MCP overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    content = content.replace(replacement.from, replacement.to)
  }
  write(file, content)
}

function addDesktopDependencies() {
  const packageFile = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(read(packageFile))
  packageJson.dependencies = packageJson.dependencies ?? {}
  packageJson.dependencies['@modelcontextprotocol/server'] = '^2.0.0'
  packageJson.dependencies.zod = packageJson.dependencies.zod ?? '^4.2.0'
  write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
}

const helper = String.raw`
const ZERO3_UNASSIGNED_PROJECT_ID = '__zero3_unassigned__'

function zero3ProjectContextMcpConfig(projectId?: string): Record<string, unknown> {
  const serverPath = path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'project-context-server.mjs')
  const stateDir = path.join(app.getPath('userData'), 'zero3', 'project-context')
  return {
    'mcp_servers.zero3_project_context': {
      command: process.execPath,
      args: [serverPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ZERO3_PROJECT_CONTEXT_DIR: stateDir,
        ZERO3_ACTIVE_PROJECT_ID: projectId ?? ZERO3_UNASSIGNED_PROJECT_ID
      },
      enabled: true,
      required: true,
      startup_timeout_sec: 15,
      tool_timeout_sec: 30,
      default_tools_approval_mode: 'approve',
      enabled_tools: ['project_get_context', 'handoff_get', 'project_put_context', 'handoff_publish']
    }
  }
}

function zero3WithProjectContextMcp(method: string, params: unknown): unknown {
  if (method !== 'thread/start') return params
  const input = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  const projectId = typeof input.zero3ProjectId === 'string' && input.zero3ProjectId.trim()
    ? input.zero3ProjectId.trim()
    : undefined
  const cleanInput = { ...input }
  delete cleanInput.zero3ProjectId
  const existing = cleanInput.config && typeof cleanInput.config === 'object' && !Array.isArray(cleanInput.config)
    ? (cleanInput.config as Record<string, unknown>)
    : {}
  return {
    ...cleanInput,
    config: {
      ...existing,
      ...zero3ProjectContextMcpConfig(projectId)
    }
  }
}
`

export function applyZero3ProjectContextMcp() {
  if (!fs.statSync(source).isFile()) throw new Error(`Zero3 project-context MCP source is missing: ${source}`)
  write(target, read(source))
  addDesktopDependencies()

  patchFile('electron/main.ts', [
    {
      label: 'project-context MCP helper before Codex singleton',
      appliedMarker: 'function zero3ProjectContextMcpConfig(projectId?: string): Record<string, unknown> {',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: helper + '\nconst zero3CodexAppServer = createZero3CodexAppServer()'
    },
    {
      label: 'central Codex thread/start MCP injection',
      from:
        "  async request(method: string, params: unknown, timeoutMs = ZERO3_CODEX_REQUEST_TIMEOUT_MS) {\n" +
        "    await this.ensureStarted()\n" +
        "    return this.requestStarted(method, params, timeoutMs)\n" +
        "  }",
      to:
        "  async request(method: string, params: unknown, timeoutMs = ZERO3_CODEX_REQUEST_TIMEOUT_MS) {\n" +
        "    await this.ensureStarted()\n" +
        "    return this.requestStarted(method, zero3WithProjectContextMcp(method, params), timeoutMs)\n" +
        "  }"
    },
    {
      label: 'active project parsing in Codex thread/start',
      appliedMarker: "const projectId = zero3CodexOptionalString(input.projectId, 'projectId', 256)",
      from: "  const ephemeral = zero3CodexOptionalBoolean(input.ephemeral, 'ephemeral')",
      to:
        "  const ephemeral = zero3CodexOptionalBoolean(input.ephemeral, 'ephemeral')\n" +
        "  const projectId = zero3CodexOptionalString(input.projectId, 'projectId', 256)\n" +
        "  if (projectId && !/^[A-Za-z0-9._:-]+$/.test(projectId)) throw new Error('projectId contains unsupported characters')"
    },
    {
      label: 'active project transfer into local-only Codex params',
      appliedMarker: '  if (projectId) params.zero3ProjectId = projectId',
      from: "  if (ephemeral != null) params.ephemeral = ephemeral\n  return params",
      to: "  if (ephemeral != null) params.ephemeral = ephemeral\n  if (projectId) params.zero3ProjectId = projectId\n  return params"
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'projectId on Codex thread/start renderer request',
      appliedMarker: '  projectId?: string\n  sandbox?: Zero3CodexSandbox',
      from: '  modelProvider?: string\n  sandbox?: Zero3CodexSandbox',
      to: '  modelProvider?: string\n  projectId?: string\n  sandbox?: Zero3CodexSandbox'
    }
  ])

  const primaryChat = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex', 'primary-chat.ts')
  if (fs.existsSync(primaryChat)) {
    patchFile('src/app/zero3-codex/primary-chat.ts', [
      {
        label: 'active project selection before Codex thread/start',
        appliedMarker: "window.localStorage.getItem('zero3.active-project-id')",
        from:
          "      const selection = selectedZero3Model()\n" +
          "      const response = await window.zero3Codex.thread.start({\n" +
          "        ...(cwd ? { cwd } : {}),",
        to:
          "      const selection = selectedZero3Model()\n" +
          "      const projectId = (() => {\n" +
          "        try { return window.localStorage.getItem('zero3.active-project-id')?.trim() ?? '' } catch { return '' }\n" +
          "      })()\n" +
          "      const response = await window.zero3Codex.thread.start({\n" +
          "        ...(cwd ? { cwd } : {}),\n" +
          "        ...(projectId ? { projectId } : {}),"
      }
    ])
  }
}
