import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import {
  canonicalizeCleanCodexWorktreeEol,
  canonicalizeReviewedOverlayPatchEol
} from '../../../apps/zero3-desktop/scripts/codex-overlay-eol.mjs'

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-overlay-eol-test-'))
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

test('canonicalizes reviewed CRLF patch inputs and rejects lone carriage returns', () => {
  const root = tempRoot()
  try {
    const patchDir = path.join(root, 'codex-overlays', 'patches', 'fixture')
    fs.mkdirSync(patchDir, { recursive: true })
    const patch = path.join(patchDir, '010-fixture.patch')
    fs.writeFileSync(patch, '--- a/hello.txt\r\n+++ b/hello.txt\r\n@@ -1 +1 @@\r\n-base\r\n+patched\r\n')

    assert.deepEqual(canonicalizeReviewedOverlayPatchEol(root), { rewritten: 1 })
    const normalized = fs.readFileSync(patch, 'utf8')
    assert.equal(normalized.includes('\r'), false)
    assert.equal(normalized.endsWith('\n'), true)
    assert.deepEqual(canonicalizeReviewedOverlayPatchEol(root), { rewritten: 0 })

    fs.writeFileSync(patch, 'invalid\rcarriage-return\n')
    assert.throws(
      () => canonicalizeReviewedOverlayPatchEol(root),
      /non-CRLF carriage return/
    )
  } finally {
    cleanup(root)
  }
})

test('re-materializes a semantically clean CRLF Codex worktree as LF', () => {
  const root = tempRoot()
  try {
    const codexRoot = path.join(root, 'codex')
    fs.mkdirSync(codexRoot, { recursive: true })
    git(codexRoot, ['init'])
    git(codexRoot, ['config', 'user.name', 'Zero3 Test'])
    git(codexRoot, ['config', 'user.email', 'zero3@example.invalid'])
    fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'base\n')
    git(codexRoot, ['add', 'hello.txt'])
    git(codexRoot, ['commit', '-m', 'base'])

    git(codexRoot, ['config', 'core.autocrlf', 'true'])
    fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'base\r\n')
    assert.equal(git(codexRoot, ['status', '--porcelain=v1']), '')

    const result = canonicalizeCleanCodexWorktreeEol(codexRoot)
    assert.deepEqual(result, { rewritten: true, reason: 'clean-rematerialized' })
    assert.equal(fs.readFileSync(path.join(codexRoot, 'hello.txt'), 'utf8'), 'base\n')
  } finally {
    cleanup(root)
  }
})

test('never resets tracked semantic edits while normalizing Codex EOL', () => {
  const root = tempRoot()
  try {
    const codexRoot = path.join(root, 'codex')
    fs.mkdirSync(codexRoot, { recursive: true })
    git(codexRoot, ['init'])
    git(codexRoot, ['config', 'user.name', 'Zero3 Test'])
    git(codexRoot, ['config', 'user.email', 'zero3@example.invalid'])
    fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'base\n')
    git(codexRoot, ['add', 'hello.txt'])
    git(codexRoot, ['commit', '-m', 'base'])

    fs.writeFileSync(path.join(codexRoot, 'hello.txt'), 'semantic local edit\r\n')
    const result = canonicalizeCleanCodexWorktreeEol(codexRoot)
    assert.deepEqual(result, { rewritten: false, reason: 'tracked-changes' })
    assert.equal(fs.readFileSync(path.join(codexRoot, 'hello.txt'), 'utf8'), 'semantic local edit\r\n')
  } finally {
    cleanup(root)
  }
})
