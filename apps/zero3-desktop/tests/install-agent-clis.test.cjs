const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const installer = path.join(repoRoot, 'Install-Agent-CLIs.cmd')

function source() {
  return fs.readFileSync(installer, 'utf8')
}

test('the installer refuses to run inside a packaged app container', () => {
  // A packaged app virtualises %APPDATA%, so an npm global install started from
  // inside one lands in a private overlay that looks correct from inside the
  // package and does not exist for anything else. That is exactly how both CLIs
  // ended up invisible to Zero3 while every check run from the same container
  // reported them present, so the check has to happen before npm is invoked.
  const text = source()

  const probeAt = text.indexOf('LocalCache\\Roaming')
  const installAt = text.indexOf('npm.cmd install -g')
  assert.ok(probeAt > 0, 'the installer must probe for the per-package overlay')
  assert.ok(installAt > probeAt, 'the container check must run before installing')

  // The probe has to be a real write, not an environment guess: a container is
  // detectable only by seeing where the write actually lands.
  assert.match(text, /break > "%PROBE%"/u)
  assert.match(text, /for \/d %%P in \("%LOCALAPPDATA%\\Packages\\\*"\)/u)
  assert.match(text, /if defined VIRTUALIZED goto :virtualized/u)
  // And it must clean up after itself whichever branch it takes.
  const deleteAt = text.indexOf('del "%PROBE%"')
  assert.ok(deleteAt > 0 && deleteAt < text.indexOf('if defined VIRTUALIZED'), 'the probe file must be removed before branching')
})

test('the installer checks the shims landed where Zero3 searches', () => {
  const text = source()

  // npm exiting zero does not mean the shims are reachable: a redirected prefix
  // puts them somewhere Zero3 never looks.
  assert.match(text, /set "NPM_BIN=%APPDATA%\\npm"/u)
  assert.match(text, /if not exist "%NPM_BIN%\\claude\.cmd" goto :verify_failed/u)
  assert.match(text, /if not exist "%NPM_BIN%\\codex\.cmd" goto :verify_failed/u)
  assert.match(text, /npm config get prefix/u)
})

test('the installer runs each CLI rather than trusting the shim file', () => {
  const text = source()

  // A shim is a text file naming a target npm may never have written: skipping
  // claude-code's postinstall leaves claude.cmd pointing at an absent binary
  // while npm still exits zero. Running --version walks the same chain Zero3
  // does, so a half-install fails here instead of in the session picker.
  assert.match(text, /call "%NPM_BIN%\\claude\.cmd" --version/u)
  assert.match(text, /call "%NPM_BIN%\\codex\.cmd" --version/u)
  assert.match(text, /if not defined CLAUDE_VERSION set "BROKEN=claude"/u)
  assert.match(text, /goto :cli_broken/u)
})

test('claude-code is installed with its postinstall allowed, and nothing else is', () => {
  const text = source()

  // That postinstall is what places claude.exe. The allowance is scoped to the
  // one package: no global config change, nothing else gains script rights.
  assert.match(text, /--allow-scripts=@anthropic-ai\/claude-code @anthropic-ai\/claude-code/u)
  assert.doesNotMatch(text, /npm config set allow-scripts/u)
  assert.doesNotMatch(text, /--allow-scripts=@openai/u)
})

test('both CLIs go through npm.cmd, and control returns after each', () => {
  const text = source()

  // npm.ps1 is blocked by the default PowerShell execution policy, and npm.cmd
  // is a batch file: without `call`, control never comes back to this script.
  const invocations = [...text.matchAll(/^\s*(call )?npm\.cmd install/gmu)]
  assert.equal(invocations.length, 2, 'expected exactly the two package installs')
  for (const match of invocations) {
    assert.ok(match[1], `every npm.cmd invocation needs \`call\`: ${match[0].trim()}`)
  }
  assert.match(text, /call npm\.cmd install -g --allow-scripts=@anthropic-ai\/claude-code/u)
  assert.match(text, /call npm\.cmd install -g @openai\/codex/u)
})

test('the installer stays ASCII so cmd.exe cannot mis-parse its own branches', () => {
  const raw = fs.readFileSync(installer, 'latin1')
  const offending = [...raw].findIndex(character => character.charCodeAt(0) > 0x7f)

  assert.equal(offending, -1, `Install-Agent-CLIs.cmd must stay ASCII (first non-ASCII byte at ${offending})`)
})
