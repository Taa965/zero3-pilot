import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareCodexOverlay, verifyCodexOverlay } from '../../../scripts/codex-overlay.mjs'
import { pins } from '../../../apps/zero3-desktop/scripts/config.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const codexRoot = path.join(repoRoot, 'upstream', 'codex')

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// The engine test proves the apply/reverse contract on a fixture. This test
// proves the same contract on the *reviewed* stack: every patch of the real
// manifest must be applied once and then recognized as already applied on the
// next prepare. A later feature that inserts inside an earlier patch's context
// window breaks exactly that, and it used to be reported as
// "neither applies nor reverses cleanly" only on a real machine.
test('the reviewed Zero3 patch stack applies once and is replay-detectable', () => {
  if (!fs.existsSync(path.join(codexRoot, '.git')) && !fs.existsSync(path.join(codexRoot, 'codex-rs', 'Cargo.toml'))) {
    throw new Error('pinned Codex submodule is not initialized at upstream/codex')
  }
  assert.equal(git(codexRoot, ['rev-parse', 'HEAD']), pins.codex, 'reviewed Codex pin mismatch')

  // The guard always replays into its own detached worktree, so a developer
  // checkout that currently holds unmanaged Codex edits can still run it.
  const scratch = path.join(os.tmpdir(), `zero3-reviewed-stack-${process.pid}-${Date.now()}`)
  const options = {
    repoRoot,
    codexRoot: scratch,
    expectedPins: { codex: pins.codex, hermes: pins.hermes, deepseek: pins.deepseek }
  }
  try {
    git(codexRoot, ['worktree', 'add', '--detach', scratch, pins.codex])

    const first = prepareCodexOverlay(options)
    assert.deepEqual(
      first.patches.map(patch => patch.state),
      first.patches.map(() => 'applied'),
      'a clean pinned tree must apply every reviewed patch'
    )

    const second = prepareCodexOverlay(options)
    assert.deepEqual(
      second.patches.map(patch => patch.state),
      second.patches.map(() => 'already-applied'),
      'replaying the reviewed stack must detect every patch as already applied'
    )

    assert.equal(verifyCodexOverlay(options).baseSha, pins.codex)
  } finally {
    try {
      git(codexRoot, ['worktree', 'remove', '--force', scratch])
    } catch {
      // The worktree never came up, or removal already happened.
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
