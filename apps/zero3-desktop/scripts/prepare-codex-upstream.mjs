import { prepareCodexOverlay } from '../../../scripts/codex-overlay.mjs'
import { applyDevelopmentGroupBridge } from './apply-development-group-bridge.mjs'
import { applyZero3ThreeColumnUi } from './apply-zero3-three-column-ui.mjs'
import { codexRoot, pins, repoRoot } from './config.mjs'

export function preparePinnedCodexUpstream() {
  // This entry point is shared by `npm run prepare` and every desktop run mode,
  // so the Development Group/runtime overlays and the authoritative Zero3
  // renderer are staged on exactly the same prepared Electron tree.
  applyDevelopmentGroupBridge()
  const result = prepareCodexOverlay({ repoRoot, codexRoot, expectedPins: pins })

  // Renderer cutover is intentionally last. Earlier compatibility overlays may
  // still prepare typed Electron bridges, but their Hermes React surfaces are
  // dead code once main.tsx is replaced by the Zero3-owned three-column shell.
  applyZero3ThreeColumnUi()

  console.log(`[Zero3 D0] Codex overlay prepared at ${result.baseSha}.`)
  console.log(`[Zero3 D0] Extensions: ${result.extensions.length}; patches: ${result.patches.length}.`)
  return result
}

if (process.argv[1]?.endsWith('prepare-codex-upstream.mjs')) {
  preparePinnedCodexUpstream()
}
