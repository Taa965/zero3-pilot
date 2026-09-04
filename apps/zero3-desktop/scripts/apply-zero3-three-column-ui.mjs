import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'renderer-v2')
const targetDir = path.join(hermesDesktopDir, 'src', 'zero3-shell')
const entryPath = path.join(hermesDesktopDir, 'src', 'zero3-shell-entry.tsx')

function requiredFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Zero3 three-column renderer source is missing: ${file}`)
  }
  return file
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function requireMarkers(source, markers, label) {
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${label} lost required real-runtime path: ${marker}`)
  }
}

function assertFunctionalRenderer(shellSource, agentDockSource) {
  requireMarkers(shellSource, [
    'runtime.zero3Codex.thread.list',
    'runtime.zero3Codex.thread.start',
    'runtime.zero3Codex.thread.read',
    'runtime.zero3Codex.turn.start',
    'runtime.zero3Codex.turn.interrupt',
    'runtime.zero3Codex.respondToServerRequest',
    'runtime.zero3Workspace.list',
    'runtime.zero3GptWeb',
    'runtime.zero3GeminiWeb',
    'ResizeObserver'
  ], 'Zero3 three-column renderer')

  requireMarkers(agentDockSource, [
    'runtime.zero3AgentTask',
    'runtime.zero3GeminiWeb.create',
    "protocol: 'zero3.pilot.task-spec.v2'",
    "completionGate: ['result.summary', 'git.clean', 'verification.no-failures', 'artifact.hashes']",
    "reviewer: reviewSessionId ? 'GPT_WEB' : 'HUMAN'"
  ], 'Zero3 agent task dock')

  // The screenshot prototype used these literal fake tool rows. They must never
  // return to the product renderer: tool cards must be projected from Codex Item
  // events/history instead.
  for (const fakeMarker of ['grep_search', 'replace_file_content']) {
    if (shellSource.includes(fakeMarker) || agentDockSource.includes(fakeMarker)) {
      throw new Error(`Zero3 renderer contains retired demo marker: ${fakeMarker}`)
    }
  }
}

export function applyZero3ThreeColumnUi() {
  const rendererFiles = [
    'zero3-shell.tsx',
    'zero3-shell.css',
    'agent-task-dock.tsx',
    'agent-task-dock.css'
  ]
  for (const file of rendererFiles) requiredFile(path.join(sourceDir, file))

  const shellText = fs.readFileSync(path.join(sourceDir, 'zero3-shell.tsx'), 'utf8')
  const agentDockText = fs.readFileSync(path.join(sourceDir, 'agent-task-dock.tsx'), 'utf8')
  assertFunctionalRenderer(shellText, agentDockText)

  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of rendererFiles) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file))
  }

  // This is the renderer cutover. Keep the pinned upstream Electron/Vite host
  // temporarily, but bypass upstream/Hermes main.tsx completely. The only
  // mounted product renderer is the Zero3-owned three-column shell and its
  // Zero3-owned task-dispatch dock.
  const entrySource = `import { createRoot } from 'react-dom/client'\n\nimport { AgentTaskDock } from './zero3-shell/agent-task-dock'\nimport { Zero3Shell } from './zero3-shell/zero3-shell'\nimport './zero3-shell/zero3-shell.css'\nimport './zero3-shell/agent-task-dock.css'\n\ndocument.documentElement.lang = 'zh-CN'\n\nconst root = document.getElementById('root')\nif (!root) throw new Error('Zero3 renderer root is missing')\n\ncreateRoot(root).render(<>\n  <Zero3Shell />\n  <AgentTaskDock />\n</>)\n`
  write(entryPath, entrySource)

  // index.html is already an approved Zero3 branding-overlay target. Point it
  // directly at our renderer entry so Hermes' React app is not imported into
  // the Vite module graph at all.
  const indexHtml = `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" />\n    <title>Zero3 Pilot</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/zero3-shell-entry.tsx"></script>\n  </body>\n</html>\n`
  write(path.join(hermesDesktopDir, 'index.html'), indexHtml)

  const manifest = {
    product: 'Zero3 Pilot',
    renderer: 'zero3-three-column-v1',
    rendererOwner: 'apps/zero3-desktop/renderer-v2',
    rendererEntry: '/src/zero3-shell-entry.tsx',
    codexUi: 'retired-not-mounted',
    hermesUi: 'retired-not-mounted',
    electronHost: 'pinned-hermes-temporary-build-host',
    runtimeBridges: [
      'window.zero3Codex',
      'window.zero3Workspace',
      'window.zero3GptWeb',
      'window.zero3GeminiWeb',
      'window.zero3AgentTask'
    ]
  }
  write(path.join(hermesDesktopDir, 'public', 'zero3-renderer.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log('[Zero3 UI] Authoritative three-column renderer staged.')
  console.log('[Zero3 UI] Agent Task dispatch is mounted inside the same Zero3 renderer.')
  console.log('[Zero3 UI] Hermes React UI: retired / not imported / not mounted.')
  console.log('[Zero3 UI] Codex OSS UI: retired / not bundled; Codex app-server remains the Agent Kernel.')
}

if (process.argv[1]?.endsWith('apply-zero3-three-column-ui.mjs')) {
  applyZero3ThreeColumnUi()
}
