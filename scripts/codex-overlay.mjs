import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const thisFile = fileURLToPath(import.meta.url)
const defaultRepoRoot = path.resolve(path.dirname(thisFile), '..')

function execGit(codexRoot, args, options = {}) {
  const output = execFileSync('git', ['-C', codexRoot, ...args], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
  return typeof output === 'string' ? output.trimEnd() : ''
}

function fail(message) {
  throw new Error(`[Zero3 Codex Overlay] ${message}`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function ensureString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function ensureSha(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    fail(`${label} must be a 40-character lowercase git SHA`)
  }
  return value
}

function normalizeRepoPath(value, label) {
  const normalized = ensureString(value, label).replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    fail(`${label} must stay inside the repository: ${value}`)
  }
  return normalized
}

function resolveInside(root, relative, label) {
  const normalized = normalizeRepoPath(relative, label).replace(/\/$/, '')
  const resolved = path.resolve(root, ...normalized.split('/'))
  const boundary = `${path.resolve(root)}${path.sep}`
  if (resolved !== path.resolve(root) && !resolved.startsWith(boundary)) {
    fail(`${label} escapes its root: ${relative}`)
  }
  return resolved
}

function validateDonor(donor, label) {
  if (!donor || typeof donor !== 'object' || Array.isArray(donor)) fail(`${label} must be an object`)
  ensureString(donor.repo, `${label}.repo`)
  ensureSha(donor.sha, `${label}.sha`)
  if (!['design-derived', 'algorithm-derived', 'code-port'].includes(donor.mode)) {
    fail(`${label}.mode is invalid: ${donor.mode}`)
  }
  if (!Array.isArray(donor.source_files) || donor.source_files.some(item => typeof item !== 'string' || !item)) {
    fail(`${label}.source_files must be an array of non-empty strings`)
  }
  ensureString(donor.license, `${label}.license`)
}

export function validateOverlayManifest(manifest, expectedPins = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object')
  if (manifest.schema_version !== 1) fail(`unsupported manifest schema_version: ${manifest.schema_version}`)
  if (manifest.runtime_authority !== 'openai-codex') {
    fail(`runtime_authority must be openai-codex, got ${manifest.runtime_authority}`)
  }
  if (!manifest.pins || typeof manifest.pins !== 'object') fail('manifest.pins is required')
  for (const key of ['codex', 'hermes', 'deepseek_harness']) ensureSha(manifest.pins[key], `pins.${key}`)
  if (expectedPins) {
    const expected = {
      codex: expectedPins.codex,
      hermes: expectedPins.hermes,
      deepseek_harness: expectedPins.deepseek ?? expectedPins.deepseek_harness
    }
    for (const [key, value] of Object.entries(expected)) {
      if (value && manifest.pins[key] !== value) {
        fail(`manifest pin mismatch for ${key}: expected ${value}, got ${manifest.pins[key]}`)
      }
    }
  }

  if (!Array.isArray(manifest.patch_order) || new Set(manifest.patch_order).size !== manifest.patch_order.length) {
    fail('patch_order must be a unique array')
  }
  const allowedFeatures = new Set(manifest.patch_order)
  if (!manifest.features || typeof manifest.features !== 'object' || Array.isArray(manifest.features)) {
    fail('features must be an object')
  }
  for (const [feature, descriptor] of Object.entries(manifest.features)) {
    if (!allowedFeatures.has(feature)) fail(`feature ${feature} is missing from patch_order`)
    if (!descriptor || typeof descriptor !== 'object') fail(`feature ${feature} descriptor is invalid`)
    ensureString(descriptor.owner, `features.${feature}.owner`)
    if (descriptor.extension_id !== null && !/^zero3-[a-z0-9-]+$/.test(descriptor.extension_id)) {
      fail(`features.${feature}.extension_id must use zero3-* naming`)
    }
    if (descriptor.extension_source !== null) {
      const source = normalizeRepoPath(descriptor.extension_source, `features.${feature}.extension_source`)
      if (!source.startsWith('codex-overlays/ext/zero3-') || !source.endsWith('/')) {
        fail(`features.${feature}.extension_source is outside the frozen extension layout`)
      }
    }
    const patchDir = normalizeRepoPath(descriptor.patch_dir, `features.${feature}.patch_dir`)
    if (patchDir !== `codex-overlays/patches/${feature}/`) {
      fail(`features.${feature}.patch_dir must be codex-overlays/patches/${feature}/`)
    }
  }

  if (!Array.isArray(manifest.extensions)) fail('extensions must be an array')
  const extensionIds = new Set()
  for (const [index, extension] of manifest.extensions.entries()) {
    const label = `extensions[${index}]`
    if (!extension || typeof extension !== 'object') fail(`${label} must be an object`)
    if (!/^zero3-[a-z0-9-]+$/.test(extension.id ?? '')) fail(`${label}.id must use zero3-* naming`)
    if (extensionIds.has(extension.id)) fail(`duplicate extension id ${extension.id}`)
    extensionIds.add(extension.id)
    if (!allowedFeatures.has(extension.feature)) fail(`${label}.feature is not in patch_order`)
    const source = normalizeRepoPath(extension.source, `${label}.source`)
    const destination = normalizeRepoPath(extension.destination, `${label}.destination`)
    if (source !== `codex-overlays/ext/${extension.id}/`) fail(`${label}.source must match its extension id`)
    if (!destination.startsWith('codex-rs/ext/zero3/') || !destination.endsWith('/')) {
      fail(`${label}.destination must stay under codex-rs/ext/zero3/`)
    }
    validateDonor(extension.donor, `${label}.donor`)
  }

  if (!Array.isArray(manifest.patches)) fail('patches must be an array')
  const patchIds = new Set()
  for (const [index, patch] of manifest.patches.entries()) {
    const label = `patches[${index}]`
    if (!patch || typeof patch !== 'object') fail(`${label} must be an object`)
    if (!/^[0-9]{3}-[a-z0-9-]+$/.test(patch.id ?? '')) fail(`${label}.id must start with a 3-digit order`)
    if (patchIds.has(patch.id)) fail(`duplicate patch id ${patch.id}`)
    patchIds.add(patch.id)
    if (!allowedFeatures.has(patch.feature)) fail(`${label}.feature is not in patch_order`)
    const patchPath = normalizeRepoPath(patch.path, `${label}.path`)
    if (!patchPath.startsWith(`codex-overlays/patches/${patch.feature}/`) || !patchPath.endsWith('.patch')) {
      fail(`${label}.path must stay in its feature patch directory`)
    }
    if (typeof patch.core_patch !== 'boolean') fail(`${label}.core_patch must be boolean`)
    ensureString(patch.extension_gap, `${label}.extension_gap`)
    validateDonor(patch.donor, `${label}.donor`)
  }
  return manifest
}

export function loadOverlayManifest(repoRoot = defaultRepoRoot, expectedPins = null) {
  const file = path.join(repoRoot, 'codex-overlays', 'manifest.json')
  if (!fs.existsSync(file)) fail(`manifest not found: ${file}`)
  return validateOverlayManifest(readJson(file), expectedPins)
}

function gitHead(codexRoot) {
  return execGit(codexRoot, ['rev-parse', 'HEAD']).trim()
}

function assertBaseSha(codexRoot, expectedSha) {
  const actual = gitHead(codexRoot)
  if (actual !== expectedSha) fail(`Codex base SHA mismatch: expected ${expectedSha}, got ${actual}`)
}

function listPatchFiles(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && entry.name.endsWith('.patch')) out.push(absolute)
    }
  }
  visit(root)
  return out
}

function orderedPatches(manifest) {
  const featureOrder = new Map(manifest.patch_order.map((feature, index) => [feature, index]))
  return [...manifest.patches].sort((a, b) => {
    const byFeature = featureOrder.get(a.feature) - featureOrder.get(b.feature)
    return byFeature || a.id.localeCompare(b.id)
  })
}

function assertPatchInventory(repoRoot, manifest) {
  const patchRoot = path.join(repoRoot, 'codex-overlays', 'patches')
  const listed = new Set(manifest.patches.map(patch => resolveInside(repoRoot, patch.path, `patch ${patch.id}`)))
  const discovered = listPatchFiles(patchRoot)
  const extras = discovered.filter(file => !listed.has(path.resolve(file)))
  if (extras.length > 0) {
    fail(`unlisted patch files are forbidden:\n${extras.map(file => `- ${path.relative(repoRoot, file)}`).join('\n')}`)
  }
  for (const file of listed) if (!fs.existsSync(file)) fail(`listed patch file is missing: ${path.relative(repoRoot, file)}`)
}

function patchTouchedPaths(patchFile) {
  const source = fs.readFileSync(patchFile, 'utf8')
  const paths = new Set()
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/)
    if (match && match[1] !== '/dev/null') paths.add(match[1])
  }
  return [...paths]
}

function allowedCodexChanges(repoRoot, manifest) {
  const exact = new Set()
  const prefixes = []
  for (const patch of manifest.patches) {
    const patchFile = resolveInside(repoRoot, patch.path, `patch ${patch.id}`)
    for (const touched of patchTouchedPaths(patchFile)) exact.add(touched.replaceAll('\\', '/'))
  }
  for (const extension of manifest.extensions) prefixes.push(extension.destination.replace(/\/$/, ''))
  return { exact, prefixes }
}

function parseStatusPaths(output) {
  if (!output.trim()) return []
  const paths = []
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue
    let value = line.slice(3).trim()
    if (value.includes(' -> ')) value = value.split(' -> ').at(-1)
    value = value.replace(/^"|"$/g, '').replaceAll('\\', '/')
    paths.push(value)
  }
  return paths
}

function assertOnlyManagedChanges(codexRoot, repoRoot, manifest) {
  const status = execGit(codexRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  const paths = parseStatusPaths(status)
  if (paths.length === 0) return
  const allowed = allowedCodexChanges(repoRoot, manifest)
  const unexpected = paths.filter(candidate => {
    if (allowed.exact.has(candidate)) return false
    return !allowed.prefixes.some(prefix => candidate === prefix || candidate.startsWith(`${prefix}/`))
  })
  if (unexpected.length > 0) {
    fail(`Codex worktree has unmanaged changes:\n${unexpected.map(file => `- ${file}`).join('\n')}`)
  }
}

function filesRecursively(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) visit(child, childRelative)
      else if (entry.isFile()) files.push(childRelative)
      else fail(`extension source may contain only files/directories: ${child}`)
    }
  }
  visit(root, '')
  return files.sort()
}

function installExtension(repoRoot, codexRoot, extension) {
  const source = resolveInside(repoRoot, extension.source, `extension ${extension.id} source`)
  const destination = resolveInside(codexRoot, extension.destination, `extension ${extension.id} destination`)
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) fail(`extension source missing: ${extension.source}`)
  const sourceFiles = filesRecursively(source)
  const destinationFiles = filesRecursively(destination)
  const sourceSet = new Set(sourceFiles)
  const extras = destinationFiles.filter(file => !sourceSet.has(file))
  if (extras.length > 0) fail(`extension ${extension.id} destination has unmanaged files: ${extras.join(', ')}`)
  fs.mkdirSync(destination, { recursive: true })
  for (const relative of sourceFiles) {
    const from = path.join(source, ...relative.split('/'))
    const to = path.join(destination, ...relative.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (fs.existsSync(to)) {
      const a = fs.readFileSync(from)
      const b = fs.readFileSync(to)
      if (!a.equals(b)) fail(`extension ${extension.id} destination differs from reviewed source: ${relative}`)
      continue
    }
    fs.copyFileSync(from, to)
  }
}

function canApply(codexRoot, patchFile, reverse = false) {
  try {
    const args = ['apply']
    if (reverse) args.push('--reverse')
    args.push('--check', '--whitespace=nowarn', patchFile)
    execGit(codexRoot, args)
    return true
  } catch {
    return false
  }
}

function applyPatch(codexRoot, patchFile, patchId) {
  if (canApply(codexRoot, patchFile, false)) {
    execGit(codexRoot, ['apply', '--whitespace=nowarn', patchFile])
    return 'applied'
  }
  if (canApply(codexRoot, patchFile, true)) return 'already-applied'
  fail(`patch ${patchId} neither applies nor reverses cleanly; pinned Codex drift or unmanaged edits detected`)
}

export function prepareCodexOverlay({ repoRoot = defaultRepoRoot, codexRoot, expectedPins = null, baseSha = null } = {}) {
  if (!codexRoot) fail('codexRoot is required')
  const manifest = loadOverlayManifest(repoRoot, expectedPins)
  const expectedBase = baseSha ?? manifest.pins.codex
  assertBaseSha(codexRoot, expectedBase)
  assertPatchInventory(repoRoot, manifest)
  assertOnlyManagedChanges(codexRoot, repoRoot, manifest)

  const extensions = []
  for (const extension of manifest.extensions) {
    installExtension(repoRoot, codexRoot, extension)
    extensions.push(extension.id)
  }
  const patches = []
  for (const patch of orderedPatches(manifest)) {
    const patchFile = resolveInside(repoRoot, patch.path, `patch ${patch.id}`)
    patches.push({ id: patch.id, state: applyPatch(codexRoot, patchFile, patch.id) })
  }

  assertOnlyManagedChanges(codexRoot, repoRoot, manifest)
  return { baseSha: expectedBase, extensions, patches }
}

export function verifyCodexOverlay({ repoRoot = defaultRepoRoot, codexRoot, expectedPins = null } = {}) {
  if (!codexRoot) fail('codexRoot is required')
  const manifest = loadOverlayManifest(repoRoot, expectedPins)
  assertBaseSha(codexRoot, manifest.pins.codex)
  assertPatchInventory(repoRoot, manifest)
  assertOnlyManagedChanges(codexRoot, repoRoot, manifest)
  return { baseSha: manifest.pins.codex, extensions: manifest.extensions.length, patches: manifest.patches.length }
}

export function replayCodexOverlay({ repoRoot = defaultRepoRoot, codexRoot, expectedPins = null, baseSha = null } = {}) {
  if (!codexRoot) fail('codexRoot is required')
  const manifest = loadOverlayManifest(repoRoot, expectedPins)
  const replayBase = baseSha ?? manifest.pins.codex
  ensureSha(replayBase, 'replay base SHA')
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-codex-overlay-replay-'))
  const replayRoot = path.join(tempParent, 'codex')
  try {
    execGit(codexRoot, ['worktree', 'add', '--detach', replayRoot, replayBase], { stdio: ['ignore', 'ignore', 'pipe'] })
    const result = prepareCodexOverlay({ repoRoot, codexRoot: replayRoot, expectedPins, baseSha: replayBase })
    return { ...result, replay: true }
  } finally {
    try {
      execGit(codexRoot, ['worktree', 'remove', '--force', replayRoot], { stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      try { execGit(codexRoot, ['worktree', 'prune']) } catch {}
    }
    fs.rmSync(tempParent, { recursive: true, force: true })
  }
}

export function resetCodexOverlay({ repoRoot = defaultRepoRoot, codexRoot, expectedPins = null } = {}) {
  if (!codexRoot) fail('codexRoot is required')
  const manifest = loadOverlayManifest(repoRoot, expectedPins)
  assertBaseSha(codexRoot, manifest.pins.codex)
  execGit(codexRoot, ['reset', '--hard', manifest.pins.codex], { stdio: ['ignore', 'ignore', 'pipe'] })
  for (const extension of manifest.extensions) {
    const destination = resolveInside(codexRoot, extension.destination, `extension ${extension.id} destination`)
    fs.rmSync(destination, { recursive: true, force: true })
  }
  for (const patch of manifest.patches) {
    const patchFile = resolveInside(repoRoot, patch.path, `patch ${patch.id}`)
    for (const touched of patchTouchedPaths(patchFile)) {
      let existedAtBase = true
      try {
        execGit(codexRoot, ['cat-file', '-e', `${manifest.pins.codex}:${touched}`])
      } catch {
        existedAtBase = false
      }
      if (!existedAtBase) fs.rmSync(resolveInside(codexRoot, touched, `patch ${patch.id} generated path`), { recursive: true, force: true })
    }
  }
  const status = execGit(codexRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim()) fail(`Codex overlay reset left changes behind:\n${status}`)
  return { baseSha: manifest.pins.codex }
}

async function loadDefaultConfig(repoRoot) {
  const configPath = path.join(repoRoot, 'apps', 'zero3-desktop', 'scripts', 'config.mjs')
  return import(`${pathToFileURL(configPath).href}?overlay=${Date.now()}`)
}

export async function runOverlayCli(argv = process.argv.slice(2), repoRoot = defaultRepoRoot) {
  const [command = 'prepare', maybeBase] = argv
  const config = await loadDefaultConfig(repoRoot)
  const options = { repoRoot, codexRoot: config.codexRoot, expectedPins: config.pins }
  let result
  if (command === 'prepare') result = prepareCodexOverlay(options)
  else if (command === 'verify') result = verifyCodexOverlay(options)
  else if (command === 'replay') result = replayCodexOverlay({ ...options, baseSha: maybeBase ?? null })
  else if (command === 'reset') result = resetCodexOverlay(options)
  else fail(`unknown command ${command}; expected prepare, verify, replay, or reset`)
  console.log(`[Zero3 Codex Overlay] ${command} succeeded: ${JSON.stringify(result)}`)
  return result
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedAs === thisFile) {
  runOverlayCli().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
