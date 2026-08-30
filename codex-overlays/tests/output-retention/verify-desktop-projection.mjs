import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8')
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message)
}

const baseProjection = read('apps/zero3-desktop/scripts/apply-codex-item-rendering.mjs')
const moreItems = read('apps/zero3-desktop/scripts/apply-codex-more-items.mjs')

// D1 must keep the desktop's raw/event Item projection independent from the
// bounded model projection. Command UI reads the app-server Item output rather
// than a function-call-output transcript generated for the model.
requirePattern(
  baseProjection,
  /output:\s*typeof item\.aggregatedOutput === 'string' \? item\.aggregatedOutput : ''/,
  'Desktop command projection no longer preserves Codex aggregatedOutput',
)

// Native/dynamic tool Items already have a typed presentation path. D1 recovery
// tools can use the existing tool-card rendering instead of inventing a second
// renderer or exposing a generic Codex RPC surface.
requirePattern(
  moreItems,
  /if \(item\.type === 'dynamicToolCall'\) return dynamicToolPayload\(item, phase\)/,
  'Desktop dynamicToolCall projection is missing',
)
requirePattern(
  moreItems,
  /content_items:\s*contentItems/,
  'Desktop dynamic tool projection no longer preserves structured content items',
)

// Preserve the existing fail-closed policy: ordinary opaque/encrypted function
// outputs are not dumped into chat merely to surface a Zero3 locator.
requirePattern(
  moreItems,
  /if \(item\.type === 'functionCallOutput'\) return null/,
  'Desktop functionCallOutput fail-closed policy changed',
)

console.log('D1 desktop projection contract verified: raw Item UI remains separate from model projection')
