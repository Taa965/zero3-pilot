import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { probeShellCapabilities } from './shell-capabilities.ts'

function resolver(command: string) {
  return { command: `C:/zero3/bin/${command}.exe`, args: [] }
}

function commandName(command: string): string {
  return path.basename(command, path.extname(command)).toLowerCase()
}

test('Windows shell capability discovery prefers pwsh and keeps Codex-native policy', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const snapshot = await probeShellCapabilities({
    platform: 'win32',
    resolveCommand: resolver,
    run: async (command, args) => {
      calls.push({ command, args })
      const name = commandName(command)
      if (name === 'pwsh') return { stdout: '7.6.0\n', stderr: '' }
      if (name === 'powershell') return { stdout: '5.1.26100.1\n', stderr: '' }
      if (name === 'cmd') return { stdout: 'Microsoft Windows [Version 10.0.26100.1]\n', stderr: '' }
      if (name === 'wsl') return { stdout: 'WSL version: 2.5.9.0\n', stderr: '' }
      throw new Error(`unexpected command ${command}`)
    }
  })

  assert.equal(snapshot.policy, 'codex-native')
  assert.equal(snapshot.preferred, 'pwsh')
  assert.deepEqual(snapshot.shells.map(shell => [shell.kind, shell.status]), [
    ['pwsh', 'ready'],
    ['powershell', 'ready'],
    ['cmd', 'ready'],
    ['wsl', 'ready']
  ])
  assert.equal(snapshot.shells[0].version, '7.6.0')
  assert.equal(snapshot.shells[2].version, '10.0.26100.1')
  assert.equal(calls[0].args.includes('-NoProfile'), true)
})

test('Windows shell capability discovery falls back to Windows PowerShell when pwsh is unavailable', async () => {
  const snapshot = await probeShellCapabilities({
    platform: 'win32',
    resolveCommand: resolver,
    run: async command => {
      const name = commandName(command)
      if (name === 'pwsh') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      if (name === 'powershell') return { stdout: '5.1.26100.1\n', stderr: '' }
      if (name === 'cmd') return { stdout: 'Microsoft Windows [Version 10.0.26100.1]\n', stderr: '' }
      throw new Error('unavailable')
    }
  })

  assert.equal(snapshot.preferred, 'powershell')
  assert.equal(snapshot.shells.find(shell => shell.kind === 'pwsh')?.status, 'unavailable')
  assert.equal(snapshot.shells.find(shell => shell.kind === 'powershell')?.status, 'ready')
})

test('non-Windows discovery exposes pwsh, bash and sh without inventing a second shell policy', async () => {
  const snapshot = await probeShellCapabilities({
    platform: 'linux',
    resolveCommand: command => ({ command, args: [] }),
    run: async command => {
      if (command === 'pwsh') throw new Error('missing')
      if (command === 'bash') return { stdout: 'GNU bash, version 5.2.26(1)-release\n', stderr: '' }
      if (command === 'sh') return { stdout: '', stderr: 'sh: 0: Illegal option --\n' }
      throw new Error('unexpected')
    }
  })

  assert.equal(snapshot.policy, 'codex-native')
  assert.equal(snapshot.preferred, 'bash')
  assert.deepEqual(snapshot.shells.map(shell => shell.kind), ['pwsh', 'bash', 'sh'])
})