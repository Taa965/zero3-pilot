const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('workspace header exposes a project-scoped PowerShell action', () => {
  const source = read('ui-v2/shell/WorkspaceRouter.tsx')
  assert.match(source, /aria-label="打开 PowerShell"/)
  assert.match(source, /Codicon name="terminal-powershell"/)
  assert.match(source, /disabled=\{!activeProject\}/)
  assert.match(source, /onClick=\{onOpenPowerShell\}/)
})

test('inspector owns the embedded PowerShell terminal for the active project', () => {
  const source = read('ui-v2/shell/InspectorDrawer.tsx')
  assert.match(source, /PowerShellTerminal key=\{project\.id\} cwd=\{project\.rootPath\}/)
  assert.match(source, /cwd = 当前项目/)
})

test('embedded terminal starts the existing PTY bridge in the project cwd and rejects non-PowerShell fallbacks', () => {
  const source = read('ui-v2/shell/PowerShellTerminal.tsx')
  assert.match(source, /window\.hermesDesktop\?\.terminal/)
  assert.match(source, /api\.start\(\{ cols: term\.cols, cwd, rows: term\.rows \}\)/)
  assert.match(source, /if \(!isPowerShell\(session\.shell\)\)/)
})

test('shell opens the inspector without toggling it closed and passes the active project through', () => {
  const source = read('ui-v2/shell/Zero3AppShell.tsx')
  assert.match(source, /onOpenPowerShell=\{\(\) => setInspectorOpen\(true\)\}/)
  assert.match(source, /InspectorDrawer project=\{activeProject\}/)
})
