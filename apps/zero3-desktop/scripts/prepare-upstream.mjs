import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  codexRoot,
  deepseekRoot,
  hermesDesktopDir,
  hermesRoot,
  pins,
  repoRoot,
  resolveHermesHome,
  upstreamRoot,
  zero3Port
} from './config.mjs'
import { applyZero3ShellPolicy } from './apply-shell-policy.mjs'

const brandAssetsDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'assets')
const brandedLocaleFiles = ['ar.ts', 'en.ts', 'ja.ts', 'zh-hant.ts', 'zh.ts']

function exec(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
    ...options
  })
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function gitHead(dir) {
  return exec('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
}

function assertPin(name, dir, expected) {
  const actual = gitHead(dir)
  if (actual !== expected) {
    throw new Error(`${name} upstream pin mismatch: expected ${expected}, got ${actual}`)
  }
}

function trackedHermesChanges() {
  const output = exec('git', [
    '-C',
    hermesRoot,
    'status',
    '--porcelain',
    '--untracked-files=no'
  ]).trimEnd()
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

function assertOnlyOverlayChanges() {
  const allowed = new Set([
    'apps/desktop/package.json',
    'apps/desktop/index.html',
    'apps/desktop/assets/icon.icns',
    'apps/desktop/assets/icon.ico',
    'apps/desktop/assets/icon.png',
    'apps/desktop/public/apple-touch-icon.png',
    'apps/desktop/src/app/chat/composer/status-stack/index.tsx',
    'apps/desktop/src/app/contrib/wiring.tsx',
    'apps/desktop/src/app/settings/about-settings.tsx',
    'apps/desktop/src/app/settings/index.tsx',
    'apps/desktop/src/app/settings/providers-settings.tsx',
    'apps/desktop/src/components/boot-failure-overlay.tsx',
    'apps/desktop/src/components/chat/intro.tsx',
    'apps/desktop/src/components/onboarding/index.tsx',
    'apps/desktop/src/store/onboarding.ts',
    ...brandedLocaleFiles.map(file => `apps/desktop/src/i18n/${file}`)
  ])
  const unexpected = trackedHermesChanges().filter(file => !allowed.has(file))
  if (unexpected.length > 0) {
    throw new Error(
      `Hermes upstream contains tracked changes outside the Zero3 overlay:\n${unexpected
        .map(file => `- ${file}`)
        .join('\n')}\nCommit/stash them or use npm run reset before preparing Zero3 Desktop.`
    )
  }
}

function applyBrandOverlay() {
  const packagePath = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

  packageJson.productName = 'Zero3 Pilot'
  packageJson.description = 'Zero3 Pilot desktop shell based on the pinned Hermes Desktop architecture.'
  packageJson.build = packageJson.build ?? {}
  packageJson.build.appId = 'ai.zero3.pilot'
  packageJson.build.productName = 'Zero3 Pilot'
  packageJson.build.executableName = 'Zero3Pilot'
  packageJson.build.protocols = [
    {
      name: 'Zero3 Protocol',
      schemes: ['zero3']
    }
  ]
  packageJson.build.artifactName = 'Zero3Pilot-${version}-${os}-${arch}.${ext}'
  packageJson.build.mac = packageJson.build.mac ?? {}
  packageJson.build.mac.extendInfo = packageJson.build.mac.extendInfo ?? {}
  packageJson.build.mac.extendInfo.CFBundleDisplayName = 'Zero3 Pilot'
  packageJson.build.mac.extendInfo.CFBundleExecutable = 'Zero3Pilot'
  packageJson.build.mac.extendInfo.CFBundleName = 'Zero3 Pilot'
  for (const [key, value] of Object.entries(packageJson.build.mac.extendInfo)) {
    if (typeof value === 'string') {
      packageJson.build.mac.extendInfo[key] = value.replaceAll('Hermes', 'Zero3 Pilot')
    }
  }
  packageJson.build.dmg = packageJson.build.dmg ?? {}
  packageJson.build.dmg.title = 'Install Zero3 Pilot'
  packageJson.build.win = packageJson.build.win ?? {}
  packageJson.build.win.legalTrademarks = 'Zero3 Pilot'
  packageJson.build.linux = packageJson.build.linux ?? {}
  packageJson.build.linux.synopsis = 'Zero3 Pilot desktop agent shell.'
  packageJson.build.nsis = packageJson.build.nsis ?? {}
  packageJson.build.nsis.shortcutName = 'Zero3 Pilot'
  packageJson.build.nsis.uninstallDisplayName = 'Zero3 Pilot'

  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  const indexPath = path.join(hermesDesktopDir, 'index.html')
  const indexHtml = fs.readFileSync(indexPath, 'utf8')
  const branded = indexHtml.replace('<title>Hermes</title>', '<title>Zero3 Pilot</title>')
  if (branded === indexHtml && !indexHtml.includes('<title>Zero3 Pilot</title>')) {
    throw new Error('Hermes Desktop index title changed upstream; update the Zero3 branding overlay.')
  }
  fs.writeFileSync(indexPath, branded)

  for (const file of brandedLocaleFiles) {
    const localePath = path.join(hermesDesktopDir, 'src', 'i18n', file)
    const locale = fs.readFileSync(localePath, 'utf8')
    const productBranded = locale
      .replaceAll('Hermes Agent', 'Zero3 Pilot')
      .replaceAll('HERMES AGENT', 'ZERO3 PILOT')
      .replaceAll("Hermes couldn't start", "Zero3 Pilot couldn't start")
      .replaceAll('recommended way to run Hermes', 'recommended way to run Zero3 Pilot')
    fs.writeFileSync(localePath, productBranded)
  }

  const introPath = path.join(hermesDesktopDir, 'src', 'components', 'chat', 'intro.tsx')
  const intro = fs.readFileSync(introPath, 'utf8')
  const brandedIntro = intro.replace("const WORDMARK = 'HERMES AGENT'", "const WORDMARK = 'ZERO3 PILOT'")
  if (brandedIntro === intro && !intro.includes("const WORDMARK = 'ZERO3 PILOT'")) {
    throw new Error('Hermes chat wordmark changed upstream; update the Zero3 branding overlay.')
  }
  fs.writeFileSync(introPath, brandedIntro)

  const publicDir = path.join(hermesDesktopDir, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
  const brandFiles = [
    ['zero3-pilot.png', path.join(hermesDesktopDir, 'assets', 'icon.png')],
    ['zero3-pilot.ico', path.join(hermesDesktopDir, 'assets', 'icon.ico')],
    ['zero3-pilot.icns', path.join(hermesDesktopDir, 'assets', 'icon.icns')],
    ['zero3-pilot.png', path.join(publicDir, 'apple-touch-icon.png')]
  ]
  for (const [sourceName, target] of brandFiles) {
    const source = path.join(brandAssetsDir, sourceName)
    if (!isFile(source)) throw new Error(`Zero3 brand asset is missing: ${source}`)
    fs.copyFileSync(source, target)
  }
  fs.writeFileSync(
    path.join(publicDir, 'zero3-upstream.json'),
    `${JSON.stringify(
      {
        product: 'Zero3 Pilot',
        desktopArchitecture: 'hermes-electron-react',
        zero3Node: `http://127.0.0.1:${zero3Port}`,
        upstream: pins
      },
      null,
      2
    )}\n`
  )
}

function installZero3HermesSkill() {
  const source = path.join(repoRoot, '.agents', 'skills', 'zero3-pilot', 'SKILL.md')
  if (!isFile(source)) {
    throw new Error(`Zero3 skill source is missing: ${source}`)
  }
  const targetDir = path.join(resolveHermesHome(), 'skills', 'zero3-pilot')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(source, path.join(targetDir, 'SKILL.md'))
}

fs.mkdirSync(upstreamRoot, { recursive: true })
exec(
  'git',
  [
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--',
    'upstream/codex',
    'upstream/hermes-agent',
    'upstream/deepseek-harness'
  ],
  { stdio: 'inherit' }
)

assertPin('Codex', codexRoot, pins.codex)
assertPin('Hermes Agent', hermesRoot, pins.hermes)
assertPin('DeepSeek Harness', deepseekRoot, pins.deepseek)
assertOnlyOverlayChanges()
applyBrandOverlay()
applyZero3ShellPolicy()
installZero3HermesSkill()

console.log('Zero3 Desktop upstream prepared successfully.')
console.log(`Hermes Desktop: ${pins.hermes}`)
console.log(`Codex app-server source: ${pins.codex}`)
console.log(`DeepSeek Harness source: ${pins.deepseek}`)
console.log('Zero3 shell policy: commercial account/billing/diagnostics surfaces disabled')
console.log(`Zero3 Hermes home: ${resolveHermesHome()}`)
console.log(`Zero3 Node endpoint: http://127.0.0.1:${zero3Port}`)
