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
import { applyZero3ChineseUi } from './apply-chinese-ui.mjs'
import { applyZero3MemoryBridge } from './apply-memory-bridge.mjs'
import { applyZero3NativeBridge } from './apply-native-bridge.mjs'
import { applyZero3NativeChat } from './apply-native-chat.mjs'
import { applyZero3NativeChatHardening } from './apply-native-chat-hardening.mjs'
import { applyZero3ScheduleBridge } from './apply-schedule-bridge.mjs'
import { applyZero3ScheduleLifecycle } from './apply-schedule-lifecycle.mjs'
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
    'apps/desktop/electron/main.ts',
    'apps/desktop/electron/preload.ts',
    'apps/desktop/public/apple-touch-icon.png',
    'apps/desktop/src/app/chat/composer/status-stack/index.tsx',
    'apps/desktop/src/app/command-palette/index.tsx',
    'apps/desktop/src/app/context-menu/app-context-menu.tsx',
    'apps/desktop/src/app/contrib/hooks/use-desktop-integrations.ts',
    'apps/desktop/src/app/contrib/wiring.tsx',
    'apps/desktop/src/app/settings/about-settings.tsx',
    'apps/desktop/src/app/settings/connections-registry.tsx',
    'apps/desktop/src/app/settings/index.tsx',
    'apps/desktop/src/app/settings/providers-settings.tsx',
    'apps/desktop/src/app/settings/types.ts',
    'apps/desktop/src/components/assistant-ui/thread/assistant-message.tsx',
    'apps/desktop/src/components/boot-failure-overlay.tsx',
    'apps/desktop/src/components/brand-mark.tsx',
    'apps/desktop/src/components/chat/intro.tsx',
    'apps/desktop/src/components/onboarding/index.tsx',
    'apps/desktop/src/global.d.ts',
    'apps/desktop/src/i18n/languages.ts',
    'apps/desktop/src/store/onboarding.ts',
    'apps/desktop/src/store/updates.ts',
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

function brandLocaleText(source) {
  // Locale files mix user-facing strings with TypeScript identifiers such as
  // `startingHermesDesktop`. A global Hermes -> Zero3 replacement corrupts
  // those identifiers. Only rewrite the portion of a line after its first
  // string delimiter, which covers locale copy while leaving keys/import names
  // intact. Multi-line values begin with their delimiter on the continuation
  // line and are handled the same way.
  return source
    .split('\n')
    .map(line => {
      const indexes = [line.indexOf("'"), line.indexOf('"'), line.indexOf('`')].filter(index => index >= 0)
      if (indexes.length === 0) return line
      const start = Math.min(...indexes)
      return line.slice(0, start) + line.slice(start).replaceAll('Hermes', 'Zero3 Pilot')
    })
    .join('\n')
}

function applyBrandOverlay() {
  const packagePath = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

  packageJson.productName = 'Zero3 Pilot'
  packageJson.description = 'Zero3 Pilot desktop shell based on the pinned Hermes Desktop architecture.'
  packageJson.author = 'Zero3 Pilot'
  packageJson.repository = {
    type: 'git',
    url: 'git+https://github.com/Taa965/zero3-pilot.git'
  }
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
    fs.writeFileSync(localePath, brandLocaleText(locale))
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
    ['zero3-pilot.png', path.join(publicDir, 'apple-touch-icon.png')],
    ['zero3-pilot.png', path.join(publicDir, 'zero3-pilot.png')]
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
applyZero3ChineseUi()
applyZero3NativeBridge()
applyZero3NativeChat()
applyZero3NativeChatHardening()
applyZero3MemoryBridge()
applyZero3ScheduleBridge()
applyZero3ScheduleLifecycle()
installZero3HermesSkill()

console.log('Zero3 Desktop upstream prepared successfully.')
console.log(`Hermes Desktop source pin: ${pins.hermes}`)
console.log(`Codex app-server source: ${pins.codex}`)
console.log(`DeepSeek Harness source: ${pins.deepseek}`)
console.log('Zero3 shell policy: upstream commercial, diagnostics and self-update surfaces disabled')
console.log('Zero3 UI policy: Simplified Chinese is the default locale; explicit user language choices remain supported')
console.log('Zero3 native bridge: fixed reads, approved Agent dispatch, hardened native Chat, native-approved Memory writes, Agent schedules, and typed schedule pause/resume')
console.log(`Zero3 Hermes home: ${resolveHermesHome()}`)
console.log(`Zero3 Node endpoint: http://127.0.0.1:${zero3Port}`)
