import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
}

function gitSucceeds(cwd, args) {
  try {
    git(cwd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function patchFiles(root) {
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
  return out.sort()
}

export function canonicalizeReviewedOverlayPatchEol(repoRoot) {
  const root = path.join(repoRoot, 'codex-overlays', 'patches')
  let rewritten = 0
  for (const file of patchFiles(root)) {
    const source = fs.readFileSync(file, 'utf8')
    const normalized = source.replace(/\r\n/g, '\n')
    if (normalized.includes('\r')) {
      throw new Error(`Reviewed Codex overlay patch contains a non-CRLF carriage return: ${file}`)
    }
    if (normalized !== source) {
      fs.writeFileSync(file, normalized, 'utf8')
      rewritten += 1
    }
  }
  return { rewritten }
}

export function canonicalizeCleanCodexWorktreeEol(codexRoot) {
  // A Windows checkout can be semantically clean while tracked files are
  // materialized as CRLF because core.autocrlf=true. The reviewed Zero3 patch
  // chain is canonical LF. Re-materialize tracked Codex bytes only when both
  // the index and tracked worktree are clean; reset --hard never deletes
  // untracked extension files, and we refuse to touch semantic local edits.
  const indexClean = gitSucceeds(codexRoot, ['diff', '--cached', '--quiet', '--ignore-submodules', '--'])
  const trackedWorktreeClean = gitSucceeds(codexRoot, ['diff', '--quiet', '--ignore-submodules', '--'])
  if (!indexClean || !trackedWorktreeClean) {
    return { rewritten: false, reason: 'tracked-changes' }
  }

  git(codexRoot, ['-c', 'core.autocrlf=false', 'reset', '--hard', 'HEAD'], {
    stdio: ['ignore', 'ignore', 'pipe']
  })

  const canonicalIndexClean = gitSucceeds(codexRoot, [
    '-c',
    'core.autocrlf=false',
    'diff',
    '--cached',
    '--quiet',
    '--ignore-submodules',
    '--'
  ])
  const canonicalWorktreeClean = gitSucceeds(codexRoot, [
    '-c',
    'core.autocrlf=false',
    'diff',
    '--quiet',
    '--ignore-submodules',
    '--'
  ])
  if (!canonicalIndexClean || !canonicalWorktreeClean) {
    throw new Error('Canonical LF rematerialization left tracked Codex changes behind.')
  }

  return { rewritten: true, reason: 'clean-rematerialized' }
}
