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
  upstreamRoot
} from './config.mjs'
import { applyZero3ChineseUi } from './apply-chinese-ui.mjs'
import { applyZero3CodexItemRenderingHardening } from './apply-codex-item-rendering-hardening.mjs'
import { applyZero3CodexItemRendering } from './apply-codex-item-rendering.mjs'
import { applyZero3CodexPrimaryChat } from './apply-codex-primary-chat.mjs'
import { applyZero3CodexPromptQueueHardening } from './apply-codex-prompt-queue-hardening.mjs'
import { applyZero3CodexPrompts } from './apply-codex-prompts.mjs'
import { applyZero3CodexSessionListGuard } from './apply-codex-session-list-guard.mjs'
import { applyZero3CodexStructuredInput } from './apply-codex-structured-input.mjs'
import { applyZero3CodexTransport } from './apply-codex-transport.mjs'
import { applyZero3ControlRuntime } from './apply-control-runtime.mjs'
import { applyZero3GptWebProvider } from './apply-gpt-web-provider.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3RemoteHostRuntime } from './apply-remote-host-runtime.mjs'
import { applyZero3ShellPolicy } from './apply-shell-policy.mjs'
import { applyZero3WorkspaceEntryRuntime } from './apply-workspace-entry-runtime.mjs'

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
  // R3D permits only the reviewed shell transformations plus the typed Codex
  // app-server boundary, primary-chat adapter, native prompt/item presentation,
  // structured UserInput mapping and native Thread lifecycle surfaces. Retired
  // Zero3 Node bridges stay disabled. H0-H3 Remote Host adds only untracked
  // Zero3-owned Electron-main source templates plus reviewed main.ts wiring.
  const allowed = new Set([
    'apps/desktop/package.json',
    'apps/desktop/index.html',
    'apps/desktop/assets/icon.icns',
    'apps/desktop/assets/icon.ico',
    'apps/desktop/assets/icon.png',
    'apps/desktop/electron/main.ts',
    'apps/desktop/electron/preload.ts',
    'apps/desktop/public/apple-touch-icon.png',
    'apps/desktop/src/app/chat/index.tsx',
    'apps/desktop/src/app/chat/sidebar/index.tsx',
    'apps/desktop/src/app/chat/composer/status-stack/index.tsx',
    'apps/desktop/src/app/chat/sidebar/session-actions-menu.tsx',
    'apps/desktop/src/app/command-palette/index.tsx',
    'apps/desktop/src/app/context-menu/app-context-menu.tsx',
    'apps/desktop/src/app/contrib/hooks/use-desktop-integrations.ts',
    'apps/desktop/src/app/contrib/wiring.tsx',
    'apps/desktop/src/app/session/hooks/use-session-list-actions.ts',
    'apps/desktop/src/app/settings/about-settings.tsx',
    'apps/desktop/src/app/settings/connections-registry.tsx',
    'apps/desktop/src/app/settings/index.tsx',
    'apps/desktop/src/app/settings/providers-settings.tsx',
    'apps/desktop/src/app/settings/sessions-settings.tsx',
    'apps/desktop/src/app/settings/types.ts',
    'apps/desktop/src/components/assistant-ui/thread/assistant-message.tsx',
    'apps/desktop/src/components/assistant-ui/tool/fallback-model/index.ts',
    'apps/desktop/src/components/boot-failure-overlay.tsx',
    'apps/desktop/src/components/brand-mark.tsx',
    'apps/desktop/src/components/chat/intro.tsx',
    'apps/desktop/src/components/onboarding/index.tsx',
    'apps/desktop/src/components/prompt-overlays.tsx',
    'apps/desktop/src/global.d.ts',
    'apps/desktop/src/i18n/languages.ts',
    'apps/desktop/src/store/onboarding.ts',
    'apps/desktop/src/store/prompts.ts',
    'apps/desktop/src/store/updates.ts',
    ...brandedLocaleFiles.map(file => `apps/desktop/src/i18n/${file}`)
  ])
  const unexpected = trackedHermesChanges().filter(file => !allowed.has(file))
  if (unexpected.length > 0) {
    throw new Error(
      `Hermes upstream contains tracked changes outside the Zero3 shell overlay:\n${unexpected
        .map(file => `- ${file}`)
        .join('\n')}\nCommit/stash them or use npm run reset before preparing Zero3 Desktop.`
    )
  }
}

function brandLocaleText(source) {
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
  packageJson.description = 'Zero3 Pilot Codex-core desktop shell based on the pinned Hermes Desktop UI architecture.'
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
  packageJson.build.linux.synopsis = 'Zero3 Pilot Codex-core desktop agent shell.'
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
        coreRuntime: 'openai-codex-app-server',
        desktopShell: 'hermes-electron-react',
        deepseekRole: 'capability-donor',
        migrationPhase: 'R1A-codex-app-server-transport',
        primaryChatPhase: 'R2A-codex-primary-chat',
        promptPhase: 'R2B-codex-approval-input',
        itemRenderingPhase: 'R3A-codex-item-rendering',
        structuredInputPhase: 'R3C-codex-structured-input',
        remoteHostPhase: 'H0-H3-remote-host-runtime',
        upstream: pins
      },
      null,
      2
    )}\n`
  )
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
applyZero3CodexTransport()
applyZero3ProjectContextMcp()
applyZero3WorkspaceEntryRuntime()
applyZero3GptWebProvider()
applyZero3ControlRuntime()
applyZero3GptWebUi()
applyZero3CodexPrimaryChat()
applyZero3CodexPrompts()
applyZero3CodexPromptQueueHardening()
applyZero3CodexItemRendering()
applyZero3CodexItemRenderingHardening()
applyZero3CodexSessionListGuard()
applyZero3CodexStructuredInput()
applyZero3RemoteHostRuntime()

console.log('Zero3 Desktop R3D + Remote Host H0-H3 shell prepared successfully.')
console.log(`Codex CORE source pin: ${pins.codex}`)
console.log(`Hermes UI shell source pin: ${pins.hermes}`)
console.log(`DeepSeek capability-donor source pin: ${pins.deepseek}`)
console.log('Zero3 architecture: Codex app-server is the only target Agent Kernel; Hermes is UI shell only.')
console.log('R3C: Hermes composer images use native Codex localImage; other attachment context is encoded as validated Codex text input.')
console.log('R3C safety: Renderer may submit only text/localImage structured inputs; default sandbox stays read-only and unsupported server requests stay fail-closed.')
console.log('R3D: archive/unarchive/delete/rename/whole-thread fork/active-turn steer use typed Codex app-server operations.')
console.log('Remote Host H0-H3: external tasks enter the same pinned Codex Thread/Turn runtime through an outbound HTTPS host node; no second agent loop or direct remote shell is introduced.')
console.log('GPT Web unified workspace: provider/UI/control overlays and the packaged project-context MCP are wired through the shared prepare pipeline.')
