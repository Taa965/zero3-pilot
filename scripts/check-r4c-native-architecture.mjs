import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = path.join(repoRoot, 'apps', 'zero3-desktop', 'executor-runtime', 'native')

function collectProductionFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectProductionFiles(fullPath))
      continue
    }
    if (!/\.(?:mjs|js|ts)$/.test(entry.name)) continue
    if (/\.(?:test|spec)\.(?:mjs|js|ts)$/.test(entry.name)) continue
    files.push(fullPath)
  }
  return files
}

function relative(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/')
}

if (!fs.existsSync(nativeRoot)) {
  throw new Error('R4C native executor directory is missing.')
}

const files = collectProductionFiles(nativeRoot)
if (files.length === 0) {
  throw new Error('R4C architecture guard found no Native Codex production modules.')
}

const forbiddenPatterns = [
  [/from\s+['"](?:node:)?fs(?:\/promises)?['"]/i, 'Native executor production code must not read credential files directly.'],
  [/\bauth\.json\b/i, 'Native executor production code must not reference auth.json.'],
  [/\baccess[_-]?token\b/i, 'Native executor production code must not handle access tokens.'],
  [/\brefresh[_-]?token\b/i, 'Native executor production code must not handle refresh tokens.'],
  [/\b(?:acpx|claude-agent-acp|openhands|goose)\b/i, 'R4C must not import or embed another Agent runtime.'],
  [/(?:^|[/'"])(?:acp|handoff|host-runtime)(?:[/'"]|$)/i, 'R4C must not cross into ACP, Handoff, or Remote Host ownership.'],
  [/child_process[^\n]*(?:exec|execSync|spawnSync)/i, 'R4C must not introduce shell/exec-style execution authority.'],
  [/\bnpx\b[^\n]*(?:latest|--yes)/i, 'R4C must not download or launch an unpinned runtime dynamically.']
]

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  for (const [pattern, message] of forbiddenPatterns) {
    if (pattern.test(source)) {
      throw new Error(`${relative(file)}: ${message}`)
    }
  }
}

const probePath = path.join(nativeRoot, 'codex-native-probe.mjs')
if (fs.existsSync(probePath)) {
  const probe = fs.readFileSync(probePath, 'utf8')
  const requiredProbeSeams = [
    "'account/read'",
    "'account/rateLimits/read'",
    "'modelProvider/capabilities/read'",
    'ZERO3_NATIVE_CODEX_HOME',
    'CODEX_HOME',
    'shell: false'
  ]
  for (const seam of requiredProbeSeams) {
    if (!probe.includes(seam)) {
      throw new Error(`apps/zero3-desktop/executor-runtime/native/codex-native-probe.mjs: missing required safe probe seam ${seam}`)
    }
  }
}

const providerSeamPath = path.join(nativeRoot, 'native-provider-seam.mjs')
if (fs.existsSync(providerSeamPath)) {
  const providerSeam = fs.readFileSync(providerSeamPath, 'utf8')
  if (!providerSeam.includes('modelProvider')) {
    throw new Error('Native provider seam must preserve the pinned Codex modelProvider override boundary.')
  }
}

console.log(`R4C Native Codex architecture guard PASS (${files.length} production module(s)).`)
