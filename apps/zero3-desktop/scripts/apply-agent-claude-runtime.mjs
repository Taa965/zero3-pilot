import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceAdapter = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime', 'claude-task-adapter.ts')
const targetAdapter = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing', 'claude-task-adapter.ts')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 Claude agent overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

export function applyZero3AgentClaudeRuntime() {
  if (!fs.statSync(sourceAdapter).isFile()) throw new Error(`Zero3 Claude task adapter source missing: ${sourceAdapter}`)
  write(targetAdapter, read(sourceAdapter))

  patchFile('electron/main.ts', [
    {
      label: 'Claude task adapter import',
      appliedMarker: 'Zero3VerificationCollector, Zero3ClaudeTaskAdapter, zero3GitEvidence',
      from: 'Zero3VerificationCollector, zero3GitEvidence',
      to: 'Zero3VerificationCollector, Zero3ClaudeTaskAdapter, zero3GitEvidence'
    },
    {
      label: 'project-scoped Claude task adapter composition',
      appliedMarker: 'const zero3ClaudeTaskAdapter = new Zero3ClaudeTaskAdapter({',
      from: 'const zero3CodexTaskAdapter = new Zero3CodexTaskAdapter(zero3LocalCodexRunner)',
      to: `const zero3CodexTaskAdapter = new Zero3CodexTaskAdapter(zero3LocalCodexRunner)
const zero3ClaudeTaskAdapter = new Zero3ClaudeTaskAdapter({
  serverPath: path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'project-context-server.mjs'),
  stateDir: path.join(app.getPath('userData'), 'zero3', 'project-context')
})`
    },
    {
      label: 'Claude provider availability probe',
      appliedMarker: 'const claudeAvailability = await zero3ClaudeTaskAdapter.availability()',
      from: '  if (geminiAuthenticated !== true && sawKnownUnauthenticated) geminiAuthenticated = false\n\n  return {',
      to: '  if (geminiAuthenticated !== true && sawKnownUnauthenticated) geminiAuthenticated = false\n\n  const claudeAvailability = await zero3ClaudeTaskAdapter.availability()\n\n  return {'
    },
    {
      label: 'Claude provider availability state',
      appliedMarker: 'claude: claudeAvailability',
      from: '    gemini: { available: geminiStatus.available, authenticated: geminiAuthenticated }\n  }',
      to: '    gemini: { available: geminiStatus.available, authenticated: geminiAuthenticated },\n    claude: claudeAvailability\n  }'
    },
    {
      label: 'Claude dispatcher dependency',
      appliedMarker: '  claude: zero3ClaudeTaskAdapter,',
      from: '  codex: zero3CodexTaskAdapter,\n  availability: zero3ProviderAvailability,',
      to: '  codex: zero3CodexTaskAdapter,\n  claude: zero3ClaudeTaskAdapter,\n  availability: zero3ProviderAvailability,'
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'CLAUDE TaskSpec target type',
      appliedMarker: "type Zero3AgentTaskTarget = 'CODEX' | 'GEMINI' | 'CLAUDE' | 'AUTO'",
      from: "type Zero3AgentTaskTarget = 'CODEX' | 'GEMINI' | 'AUTO'",
      to: "type Zero3AgentTaskTarget = 'CODEX' | 'GEMINI' | 'CLAUDE' | 'AUTO'"
    }
  ])
}
