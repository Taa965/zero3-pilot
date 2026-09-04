import { prepareCodexOverlay } from '../../../scripts/codex-overlay.mjs'
import { applyDevelopmentGroupBridge } from './apply-development-group-bridge.mjs'
import { codexRoot, pins, repoRoot } from './config.mjs'

export function preparePinnedCodexUpstream() {
  // This entry point is shared by `npm run prepare` and every desktop run mode,
  // so the Development Group overlay is staged exactly on the same prepared
  // Hermes tree before typecheck/dev/package proceeds.
  applyDevelopmentGroupBridge()
  const result = prepareCodexOverlay({ repoRoot, codexRoot, expectedPins: pins })
  console.log(`[Zero3 D0] Codex overlay prepared at ${result.baseSha}.`)
  console.log(`[Zero3 D0] Extensions: ${result.extensions.length}; patches: ${result.patches.length}.`)
  return result
}

if (process.argv[1]?.endsWith('prepare-codex-upstream.mjs')) {
  preparePinnedCodexUpstream()
}
