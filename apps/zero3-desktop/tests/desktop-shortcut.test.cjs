const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const repoRoot = path.resolve(root, '../..')
const installer = path.join(root, 'scripts', 'install-desktop-shortcut.ps1')

function installerSource() {
  return fs.readFileSync(installer, 'utf8')
}

// The comment block explains which paths are deliberately *not* used, so a
// guard that scans the raw file flags the explanation of the rule as a
// violation of it. Strip comments and check the executable text.
function installerCode() {
  return installerSource()
    .replace(/<#[\s\S]*?#>/gu, '')
    .split('\n')
    .filter(line => !/^\s*#/u.test(line))
    .map(line => line.replace(/\s+#(?![}"']).*$/u, ''))
    .join('\n')
}

test('the shortcut installer points at files that actually exist', () => {
  const source = installerSource()

  // Both paths are built in the script from repoRoot; read them back out and
  // check the real assets, so moving or renaming either one fails here rather
  // than leaving the user a blank-icon shortcut that launches nothing.
  const target = /Join-Path \$repoRoot '([^']+)'/u.exec(source)?.[1]
  const icon = /\$icon = Join-Path \$repoRoot '([^']+)'/u.exec(source)?.[1]
  assert.equal(target, 'Start-Zero3.cmd')
  assert.ok(icon, 'the installer must name an icon asset')

  assert.ok(fs.existsSync(path.join(repoRoot, target)), `missing shortcut target: ${target}`)
  assert.ok(fs.existsSync(path.join(repoRoot, icon)), `missing shortcut icon: ${icon}`)
})

test('the icon is a multi-resolution Windows icon, not a renamed image', () => {
  const icon = /\$icon = Join-Path \$repoRoot '([^']+)'/u.exec(installerSource())[1]
  const data = fs.readFileSync(path.join(repoRoot, icon))

  // ICONDIR: reserved=0, type=1 (icon), then the image count.
  assert.equal(data.readUInt16LE(0), 0, 'not an ICO container')
  assert.equal(data.readUInt16LE(2), 1, 'ICO type must be 1 (icon)')
  const count = data.readUInt16LE(4)
  assert.ok(count >= 4, `expected several sizes for crisp desktop and taskbar rendering, saw ${count}`)

  // Windows picks 32x32 for the desktop and 16x16 for the tray; a file without
  // them gets a blurry downscale of whatever single size is present.
  const widths = new Set()
  for (let i = 0; i < count; i += 1) widths.add(data.readUInt8(6 + i * 16) || 256)
  for (const size of [16, 32, 48, 256]) assert.ok(widths.has(size), `icon is missing the ${size}px entry`)
})

test('the installer resolves the real Desktop folder', () => {
  const code = installerCode()

  // A OneDrive-redirected desktop is not %USERPROFILE%\Desktop, and writing to
  // the stale path creates a shortcut the user never sees.
  assert.match(code, /\[Environment\]::GetFolderPath\('Desktop'\)/u)
  assert.doesNotMatch(code, /USERPROFILE\\Desktop/u)
  // Without an explicit working directory the console starts in system32 and
  // every relative path in the launcher resolves against the wrong root.
  assert.match(code, /\$link\.WorkingDirectory = \$repoRoot/u)
})

test('the installer keeps a UTF-8 BOM so Windows PowerShell reads its Chinese text', () => {
  // Windows PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless a
  // BOM says otherwise, which turns every message in this script into mojibake
  // and can break parsing outright.
  const raw = fs.readFileSync(installer)
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'install-desktop-shortcut.ps1 must start with a UTF-8 BOM')
})
