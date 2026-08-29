import { prepareCodexOverlay } from '../../../scripts/codex-overlay.mjs'
import { codexRoot, pins, repoRoot } from './config.mjs'

export function preparePinnedCodexUpstream() {
  const result = prepareCodexOverlay({ repoRoot, codexRoot, expectedPins: pins })
  console.log(`[Zero3 D0] Codex overlay prepared at ${result.baseSha}.`)
  console.log(`[Zero3 D0] Extensions: ${result.extensions.length}; patches: ${result.patches.length}.`)
  return result
}

if (process.argv[1]?.endsWith('prepare-codex-upstream.mjs')) {
  preparePinnedCodexUpstream()
}
