import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pins } from '../apps/zero3-desktop/scripts/config.mjs'
import { loadOverlayManifest } from './codex-overlay.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = loadOverlayManifest(root, pins)

function fail(message) {
  throw new Error(`Zero3 Codex overlay architecture guard failed: ${message}`)
}

const frozenPatchOrder = [
  'foundation',
  'output-retention',
  'context-pruning',
  'lsp',
  'external-agent',
  'team',
  'jobs',
  'workflow'
]
if (JSON.stringify(manifest.patch_order) !== JSON.stringify(frozenPatchOrder)) {
  fail(`patch_order drifted; expected ${frozenPatchOrder.join(' -> ')}`)
}

const expectedOwners = {
  foundation: 'S1',
  'output-retention': 'S2',
  'context-pruning': 'S3',
  lsp: 'S4',
  'external-agent': 'S2',
  team: 'S4',
  jobs: 'S3',
  workflow: 'S2'
}
for (const [feature, owner] of Object.entries(expectedOwners)) {
  if (manifest.features[feature]?.owner !== owner) {
    fail(`feature ${feature} must remain owned by ${owner}`)
  }
}

const destinations = new Set()
for (const extension of manifest.extensions) {
  if (destinations.has(extension.destination)) fail(`duplicate extension destination ${extension.destination}`)
  destinations.add(extension.destination)
}

for (const patch of manifest.patches) {
  if (path.basename(patch.path) !== `${patch.id}.patch`) {
    fail(`patch ${patch.id} filename must exactly match its manifest id`)
  }
}

function checkDonor(donor, label) {
  const canonical = donor.repo.toLowerCase().replace(/\.git$/, '')
  if (canonical.endsWith('deepseek-ai/deepseek-harness')) {
    if (donor.sha !== pins.deepseek) fail(`${label} uses an unpinned DeepSeek-Harness SHA`)
    if (!donor.license.toLowerCase().includes('mit')) fail(`${label} must preserve the DeepSeek-Harness MIT license`)
  }
}
for (const extension of manifest.extensions) checkDonor(extension.donor, `extension ${extension.id}`)
for (const patch of manifest.patches) checkDonor(patch.donor, `patch ${patch.id}`)

function sourceFiles(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) return []
  const found = []
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && predicate(file)) found.push(file)
    }
  }
  visit(rootDir)
  return found
}

const reviewedCode = [
  ...sourceFiles(path.join(root, 'codex-overlays', 'ext'), file => !file.endsWith('.gitkeep')),
  ...sourceFiles(path.join(root, 'codex-overlays', 'patches'), file => file.endsWith('.patch'))
]
const forbiddenGenericRpc = [
  'zero3:codex:rpc',
  'zero3:codex:request',
  'zero3:codex:proxy'
]
for (const file of reviewedCode) {
  const source = fs.readFileSync(file, 'utf8')
  for (const forbidden of forbiddenGenericRpc) {
    if (source.includes(forbidden)) {
      fail(`${path.relative(root, file)} reintroduces forbidden generic renderer Codex RPC ${forbidden}`)
    }
  }
}

console.log(
  `Zero3 Codex overlay architecture guard passed: Codex-only runtime authority / ${manifest.extensions.length} extensions / ${manifest.patches.length} patches / pinned donor provenance.`
)
