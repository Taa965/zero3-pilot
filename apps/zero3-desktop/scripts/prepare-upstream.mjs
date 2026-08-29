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

function exec(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
    ...options
  })
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
  ]).trim()
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

function assertOnlyOverlayChanges() {
  const allowed = new Set(['apps/desktop/package.json', 'apps/desktop/index.html'])
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

  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  const indexPath = path.join(hermesDesktopDir, 'index.html')
  const indexHtml = fs.readFileSync(indexPath, 'utf8')
  const branded = indexHtml.replace('<title>Hermes</title>', '<title>Zero3 Pilot</title>')
  if (branded === indexHtml && !indexHtml.includes('<title>Zero3 Pilot</title>')) {
    throw new Error('Hermes Desktop index title changed upstream; update the Zero3 branding overlay.')
  }
  fs.writeFileSync(indexPath, branded)

  const publicDir = path.join(hermesDesktopDir, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
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
  if (!fs.isFileSync(source)) {
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
installZero3HermesSkill()

console.log('Zero3 Desktop upstream prepared successfully.')
console.log(`Hermes Desktop: ${pins.hermes}`)
console.log(`Codex app-server source: ${pins.codex}`)
console.log(`DeepSeek Harness source: ${pins.deepseek}`)
console.log(`Zero3 Hermes home: ${resolveHermesHome()}`)
console.log(`Zero3 Node endpoint: http://127.0.0.1:${zero3Port}`)
