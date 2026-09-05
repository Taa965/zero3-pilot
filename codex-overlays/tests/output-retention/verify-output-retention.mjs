import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXPECTED_CODEX_PIN = '94311d447587411789533c47601fd8bc9d81eb48'
const ALLOWED_PATCH_TARGETS = new Set([
  'codex-rs/tools/src/tool_output.rs',
  'codex-rs/core/src/tools/context.rs',
  'codex-rs/ext/extension-api/src/contributors.rs',
  'codex-rs/ext/extension-api/src/lib.rs',
  'codex-rs/core/src/tools/parallel.rs',
])

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const codexDir = path.join(repoRoot, 'upstream', 'codex')
const patchPath = path.join(
  repoRoot,
  'codex-overlays',
  'patches',
  'output-retention',
  '010-output-retention-tool-result-projection.patch',
)

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

if (!fs.existsSync(path.join(codexDir, '.git')) && !fs.existsSync(path.join(codexDir, 'Cargo.toml'))) {
  throw new Error('pinned Codex submodule is not initialized at upstream/codex')
}
if (!fs.existsSync(patchPath)) {
  throw new Error(`missing D1 patch: ${patchPath}`)
}

const pin = run('git', ['rev-parse', 'HEAD'], codexDir)
if (pin !== EXPECTED_CODEX_PIN) {
  throw new Error(`Codex pin mismatch: expected ${EXPECTED_CODEX_PIN}, got ${pin}`)
}

const patch = fs.readFileSync(patchPath, 'utf8')
const targets = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => {
  if (match[1] !== match[2]) {
    throw new Error(`D1 patch renames a file, which is outside the approved seam: ${match[0]}`)
  }
  return match[1]
})
if (targets.length === 0) {
  throw new Error('D1 patch contains no target files')
}
for (const target of targets) {
  if (!ALLOWED_PATCH_TARGETS.has(target)) {
    throw new Error(`D1 patch touches an unapproved Codex path: ${target}`)
  }
}
if (targets.some((target) => /approval|sandbox|guardian/i.test(target))) {
  throw new Error('D1 patch must not touch Approval, Sandbox, or Guardian paths')
}

run('git', ['apply', '--check', patchPath], codexDir)

console.log(`D1 output-retention patch verified against Codex ${EXPECTED_CODEX_PIN}`)
console.log(`Targets (${targets.length}): ${targets.join(', ')}`)
