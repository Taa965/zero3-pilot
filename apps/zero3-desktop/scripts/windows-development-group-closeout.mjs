import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopOrchestrator = path.resolve(here, '..')
const repoRoot = path.resolve(desktopOrchestrator, '..', '..')
const hermesRoot = path.join(repoRoot, 'upstream', 'hermes-agent')
const hermesDesktop = path.join(hermesRoot, 'apps', 'desktop')
const releaseDir = path.join(hermesDesktop, 'release')
const reportPath = process.env.ZERO3_DG_ACCEPTANCE_REPORT || path.join(os.tmpdir(), 'zero3-pilot-development-group-closeout.json')

if (process.platform !== 'win32') {
  throw new Error('Development Group closeout acceptance must run on Windows; Linux/macOS results are not release evidence.')
}

const report = {
  schema: 'zero3.pilot.development-group-closeout-acceptance.v1',
  startedAt: new Date().toISOString(),
  repository: repoRoot,
  branch: '',
  candidateSha: '',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  steps: [],
  installer: null,
  status: 'running'
}

function needsShell(file) {
  return process.platform === 'win32' && file.toLowerCase().endsWith('.cmd')
}

function command(file, args, cwd = repoRoot, options = {}) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    shell: options.shell ?? needsShell(file),
    env: { ...process.env, ...options.env }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = options.capture ? String(result.stderr ?? '').trim() : ''
    throw new Error(`${file} ${args.join(' ')} exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`)
  }
  return result.stdout ?? ''
}

function capture(file, args, cwd = repoRoot) {
  return String(command(file, args, cwd, { capture: true })).trim()
}

function writeReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

function runStep(id, fn) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  process.stdout.write(`\n=== ${id} ===\n`)
  try {
    const detail = fn()
    report.steps.push({ id, status: 'passed', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, detail: detail ?? null })
    writeReport()
    return detail
  } catch (error) {
    report.steps.push({ id, status: 'failed', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now().toISOString?.() ?? new Date().toISOString(), durationMs: Date.now() - started, error: error instanceof Error ? error.stack ?? error.message : String(error) })
    report.status = 'failed'
    report.finishedAt = new Date().toISOString()
    writeReport()
    throw error
  }
}

function recursivelyCollectTests(root) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...recursivelyCollectTests(target))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(target)
  }
  return files.sort()
}

function recursivelyCollectFiles(root, predicate) {
  const files = []
  if (!fs.existsSync(root)) return files
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...recursivelyCollectFiles(target, predicate))
    else if (entry.isFile() && predicate(target)) files.push(target)
  }
  return files.sort()
}

function findTsxCli() {
  const candidates = [
    path.join(hermesRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(hermesDesktop, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  ]
  const match = candidates.find(candidate => fs.existsSync(candidate))
  if (!match) throw new Error('tsx CLI was not installed by the pinned Hermes workspace install')
  return match
}

function sha256(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytes
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytes > 0) hash.update(buffer.subarray(0, bytes))
    } while (bytes > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function assertReviewedPatchLineEndings() {
  const patchRoot = path.join(repoRoot, 'codex-overlays')
  const offenders = recursivelyCollectFiles(patchRoot, file => file.endsWith('.patch'))
    .filter(file => fs.readFileSync(file).includes(0x0d))
  if (offenders.length > 0) {
    throw new Error(`reviewed Codex overlay patches contain CR bytes:\n${offenders.map(file => `- ${path.relative(repoRoot, file)}`).join('\n')}`)
  }
}

function prepareSubmodule(pathFromRoot) {
  const target = path.join(repoRoot, pathFromRoot)
  command('git', ['-C', target, 'config', 'core.autocrlf', 'false'])
  command('git', ['-C', target, 'reset', '--hard', 'HEAD'])
}

try {
  runStep('candidate-identity-and-clean-root', () => {
    const dirty = capture('git', ['status', '--porcelain', '--untracked-files=all'])
    if (dirty) throw new Error(`acceptance requires a clean candidate worktree before preparation:\n${dirty}`)
    report.branch = capture('git', ['branch', '--show-current'])
    report.candidateSha = capture('git', ['rev-parse', 'HEAD'])
    if (!/^[0-9a-f]{40}$/u.test(report.candidateSha)) throw new Error('candidate SHA is not an exact Git SHA')
    const expectedSha = process.env.ZERO3_EXPECTED_SHA?.trim()
    if (expectedSha && expectedSha !== report.candidateSha) throw new Error(`candidate SHA mismatch: expected ${expectedSha}, got ${report.candidateSha}`)
    command('git', ['config', '--local', 'core.autocrlf', 'false'])
    command('git', ['reset', '--hard', 'HEAD'])
    assertReviewedPatchLineEndings()
    return { branch: report.branch, candidateSha: report.candidateSha }
  })

  runStep('reviewed-upstream-pins', () => {
    command('git', ['submodule', 'update', '--init', '--recursive', '--', 'upstream/codex', 'upstream/hermes-agent', 'upstream/deepseek-harness'])
    for (const submodule of ['upstream/codex', 'upstream/hermes-agent', 'upstream/deepseek-harness']) prepareSubmodule(submodule)
    return {
      codex: capture('git', ['-C', 'upstream/codex', 'rev-parse', 'HEAD']),
      hermes: capture('git', ['-C', 'upstream/hermes-agent', 'rev-parse', 'HEAD']),
      deepseek: capture('git', ['-C', 'upstream/deepseek-harness', 'rev-parse', 'HEAD'])
    }
  })

  runStep('development-group-static-audit', () => {
    command(process.execPath, [path.join(here, 'check-development-group-product-wiring.mjs')])
  })

  runStep('architecture-guard', () => {
    command(process.execPath, [path.join(repoRoot, 'scripts', 'check-architecture.mjs')])
  })

  runStep('pinned-desktop-typecheck-and-overlay-prepare', () => {
    command(process.execPath, [path.join(here, 'run.mjs'), 'typecheck'])
  })

  runStep('development-group-and-executor-contract-tests', () => {
    const tests = [
      ...recursivelyCollectTests(path.join(desktopOrchestrator, 'group-runtime')),
      ...recursivelyCollectTests(path.join(desktopOrchestrator, 'executor-runtime'))
    ]
    if (tests.length === 0) throw new Error('no Development Group / Executor contract tests were discovered')
    const tsxCli = findTsxCli()
    command(process.execPath, [tsxCli, '--test', ...tests])
    return { tests: tests.map(file => path.relative(repoRoot, file).replaceAll('\\', '/')) }
  })

  runStep('prepared-desktop-lint', () => {
    command('npm.cmd', ['run', 'lint'], hermesDesktop)
  })

  runStep('prepared-desktop-ui-tests', () => {
    command('npm.cmd', ['run', 'test:ui'], hermesDesktop)
  })

  runStep('prepared-desktop-electron-tests', () => {
    command('npm.cmd', ['run', 'test:desktop:platforms'], hermesDesktop)
  })

  runStep('windows-codex-native-package', () => {
    command(process.execPath, [path.join(here, 'run.mjs'), 'dist:win'])
  })

  runStep('packaged-zero3-codex-and-installer-evidence', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(hermesDesktop, 'package.json'), 'utf8'))
    if (packageJson.productName !== 'Zero3 Pilot') throw new Error('packaged desktop lost Zero3 Pilot product identity')
    if (packageJson.build?.appId !== 'ai.zero3.pilot') throw new Error('packaged desktop lost Zero3 Pilot appId')
    if (packageJson.build?.executableName !== 'Zero3Pilot') throw new Error('packaged desktop lost Zero3Pilot executable identity')
    if (!String(packageJson.scripts?.['dist:win'] ?? '').includes('--publish never')) throw new Error('Windows package path must remain non-publishing during acceptance')

    const unpackedRoot = path.join(releaseDir, 'win-unpacked')
    const unpackedExe = path.join(unpackedRoot, 'Zero3Pilot.exe')
    const resources = path.join(unpackedRoot, 'resources')
    const appAsar = path.join(resources, 'app.asar')
    const bundledCodex = path.join(resources, 'zero3-codex', 'codex.exe')
    if (!fs.existsSync(unpackedExe) || fs.statSync(unpackedExe).size <= 0) throw new Error('packaged Zero3Pilot.exe is missing or empty')
    if (!fs.existsSync(appAsar) || fs.statSync(appAsar).size <= 0) throw new Error('packaged app.asar is missing or empty')
    if (!fs.existsSync(bundledCodex) || fs.statSync(bundledCodex).size <= 0) throw new Error('packaged pinned Codex binary is missing or empty')
    for (const name of ['LICENSE-Zero3-Pilot.txt', 'NOTICE-Zero3-Pilot.txt', 'LICENSE-OpenAI-Codex.txt', 'NOTICE-OpenAI-Codex.txt', 'LICENSE-Hermes-Agent.txt']) {
      const legal = path.join(resources, 'legal', name)
      if (!fs.existsSync(legal) || fs.statSync(legal).size <= 0) throw new Error(`packaged legal resource is missing or empty: ${name}`)
    }

    command(bundledCodex, ['--version'])
    command(process.execPath, [path.join(here, 'smoke-codex-app-server.mjs'), bundledCodex])
    command(process.execPath, [path.join(here, 'smoke-codex-session-persistence.mjs'), bundledCodex])

    const installers = fs.readdirSync(releaseDir)
      .filter(name => /^Zero3Pilot-.*\.exe$/iu.test(name) && name.toLowerCase() !== 'zero3pilot.exe')
      .map(name => path.join(releaseDir, name))
      .filter(file => fs.statSync(file).isFile())
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    if (installers.length === 0) throw new Error('Zero3 Pilot NSIS installer artifact was not produced')
    const installer = installers[0]
    report.installer = {
      path: installer,
      bytes: fs.statSync(installer).size,
      sha256: sha256(installer)
    }
    return {
      ...report.installer,
      unpackedExe,
      appAsar,
      bundledCodex,
      bundledCodexSha256: sha256(bundledCodex)
    }
  })

  if (!report.installer) throw new Error('closeout reached PASS path without installer evidence')
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  writeReport()
  process.stdout.write(`\nDEVELOPMENT_GROUP_CLOSEOUT=PASS\nCANDIDATE_SHA=${report.candidateSha}\nREPORT=${reportPath}\nINSTALLER=${report.installer.path}\nINSTALLER_SHA256=${report.installer.sha256}\n`)
} catch (error) {
  process.stderr.write(`\nDEVELOPMENT_GROUP_CLOSEOUT=FAIL\nCANDIDATE_SHA=${report.candidateSha || 'unknown'}\nREPORT=${reportPath}\n`)
  throw error
}
