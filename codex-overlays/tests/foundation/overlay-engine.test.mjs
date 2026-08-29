import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import {
  prepareCodexOverlay,
  replayCodexOverlay,
  validateOverlayManifest,
  verifyCodexOverlay
} from '../../../scripts/codex-overlay.mjs'

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function donor(sha) {
  return {
    repo: 'deepseek-ai/deepseek-harness',
    sha,
    mode: 'design-derived',
    source_files: ['example/source.ts'],
    license: 'MIT'
  }
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-overlay-test-'))
  const codexRoot = path.join(repoRoot, 'upstream', 'codex')
  fs.mkdirSync(codexRoot, { recursive: true })
  git(codexRoot, ['init'])
  git(codexRoot, ['config', 'user.name', 'Zero3 Test'])
  git(codexRoot, ['config', 'user.email', 'zero3@example.invalid'])
  fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'base\n')
  git(codexRoot, ['add', 'hello.txt'])
  git(codexRoot, ['commit', '-m', 'base'])
  const baseSha = git(codexRoot, ['rev-parse', 'HEAD'])

  const deepseek = 'd'.repeat(40)
  const hermes = 'e'.repeat(40)
  const overlayRoot = path.join(repoRoot, 'codex-overlays')
  const patchDir = path.join(overlayRoot, 'patches', 'foundation')
  const extensionSource = path.join(overlayRoot, 'ext', 'zero3-fixture')
  fs.mkdirSync(patchDir, { recursive: true })
  fs.mkdirSync(extensionSource, { recursive: true })
  fs.writeFileSync(path.join(extensionSource, 'lib.rs'), 'pub const ZERO3: &str = "fixture";\n')

  fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'patched\n')
  const patch = git(codexRoot, ['diff', '--', 'hello.txt'])
  fs.writeFileSync(path.join(patchDir, '010-foundation-fixture.patch'), `${patch}\n`)
  git(codexRoot, ['checkout', '--', 'hello.txt'])

  const manifest = {
    schema_version: 1,
    runtime_authority: 'openai-codex',
    pins: { codex: baseSha, hermes, deepseek_harness: deepseek },
    patch_order: ['foundation'],
    features: {
      foundation: {
        owner: 'S1',
        extension_id: 'zero3-fixture',
        extension_source: 'codex-overlays/ext/zero3-fixture/',
        patch_dir: 'codex-overlays/patches/foundation/'
      }
    },
    extensions: [
      {
        id: 'zero3-fixture',
        feature: 'foundation',
        source: 'codex-overlays/ext/zero3-fixture/',
        destination: 'codex-rs/ext/zero3/fixture/',
        donor: donor(deepseek)
      }
    ],
    patches: [
      {
        id: '010-foundation-fixture',
        feature: 'foundation',
        path: 'codex-overlays/patches/foundation/010-foundation-fixture.patch',
        core_patch: true,
        extension_gap: 'Fixture proves deterministic patch replay.',
        donor: donor(deepseek)
      }
    ]
  }
  fs.writeFileSync(path.join(overlayRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const expectedPins = { codex: baseSha, hermes, deepseek }
  return { repoRoot, codexRoot, baseSha, expectedPins, manifest }
}

function cleanup(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true })
}

test('validates the Codex authority and frozen zero3 extension naming', () => {
  const { repoRoot, expectedPins, manifest } = fixture()
  try {
    assert.equal(validateOverlayManifest(manifest, expectedPins), manifest)
    assert.throws(
      () => validateOverlayManifest({ ...manifest, runtime_authority: 'deepseek-harness' }, expectedPins),
      /runtime_authority must be openai-codex/
    )
    const invalid = structuredClone(manifest)
    invalid.extensions[0].destination = 'codex-rs/core/src/zero3/'
    assert.throws(() => validateOverlayManifest(invalid, expectedPins), /destination must stay under codex-rs\/ext\/zero3/)
  } finally {
    cleanup(repoRoot)
  }
})

test('applies extensions and patches deterministically and is idempotent', () => {
  const { repoRoot, codexRoot, baseSha, expectedPins } = fixture()
  try {
    const first = prepareCodexOverlay({ repoRoot, codexRoot, expectedPins })
    assert.equal(first.baseSha, baseSha)
    assert.deepEqual(first.patches, [{ id: '010-foundation-fixture', state: 'applied' }])
    assert.equal(fs.readFileSync(path.join(codexRoot, 'hello.txt'), 'utf8'), 'patched\n')
    assert.equal(
      fs.readFileSync(path.join(codexRoot, 'codex-rs', 'ext', 'zero3', 'fixture', 'lib.rs'), 'utf8'),
      'pub const ZERO3: &str = "fixture";\n'
    )

    const second = prepareCodexOverlay({ repoRoot, codexRoot, expectedPins })
    assert.deepEqual(second.patches, [{ id: '010-foundation-fixture', state: 'already-applied' }])
    assert.equal(verifyCodexOverlay({ repoRoot, codexRoot, expectedPins }).baseSha, baseSha)
  } finally {
    cleanup(repoRoot)
  }
})

test('fails loudly on an incorrect base SHA or unmanaged Codex edits', () => {
  const { repoRoot, codexRoot, expectedPins } = fixture()
  try {
    assert.throws(
      () => prepareCodexOverlay({ repoRoot, codexRoot, expectedPins, baseSha: '1'.repeat(40) }),
      /Codex base SHA mismatch/
    )
    fs.writeFileSync(path.join(codexRoot, 'unmanaged.txt'), 'do not silently accept me\n')
    assert.throws(() => prepareCodexOverlay({ repoRoot, codexRoot, expectedPins }), /unmanaged changes/)
  } finally {
    cleanup(repoRoot)
  }
})

test('rejects patch files that are not explicitly listed in the manifest', () => {
  const { repoRoot, codexRoot, expectedPins } = fixture()
  try {
    fs.writeFileSync(path.join(repoRoot, 'codex-overlays', 'patches', 'foundation', '999-foundation-hidden.patch'), 'hidden\n')
    assert.throws(() => prepareCodexOverlay({ repoRoot, codexRoot, expectedPins }), /unlisted patch files are forbidden/)
  } finally {
    cleanup(repoRoot)
  }
})

test('replays the reviewed overlay in a detached Codex worktree', () => {
  const { repoRoot, codexRoot, baseSha, expectedPins } = fixture()
  try {
    const result = replayCodexOverlay({ repoRoot, codexRoot, expectedPins })
    assert.equal(result.baseSha, baseSha)
    assert.equal(result.replay, true)
    assert.deepEqual(result.patches, [{ id: '010-foundation-fixture', state: 'applied' }])
    assert.equal(git(codexRoot, ['status', '--porcelain']), '')
  } finally {
    cleanup(repoRoot)
  }
})
