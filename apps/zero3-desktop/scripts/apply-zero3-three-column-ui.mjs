import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'renderer-v2')
const targetDir = path.join(hermesDesktopDir, 'src', 'zero3-shell')

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

export function applyZero3ThreeColumnUi() {
  const shellSource = requiredFile(path.join(sourceDir, 'zero3-shell.tsx'))
  const cssSource = requiredFile(path.join(sourceDir, 'zero3-shell.css'))

  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(shellSource, path.join(targetDir, 'zero3-shell.tsx'))
  fs.copyFileSync(cssSource, path.join(targetDir, 'zero3-shell.css'))

  // This is the renderer cutover. The pinned Hermes package is still used as a
  // temporary Electron/Vite build host, but none of its React product UI is
  // mounted. Codex's open-source UI is never bundled or mounted either.
  const mainSource = `import { createRoot } from 'react-dom/client'\n\nimport { Zero3Shell } from './zero3-shell/zero3-shell'\nimport './zero3-shell/zero3-shell.css'\n\ndocument.documentElement.lang = 'zh-CN'\n\nconst root = document.getElementById('root')\nif (!root) throw new Error('Zero3 renderer root is missing')\n\ncreateRoot(root).render(<Zero3Shell />)\n`
  write(path.join(hermesDesktopDir, 'src', 'main.tsx'), mainSource)

  const manifest = {
    product: 'Zero3 Pilot',
    renderer: 'zero3-three-column-v1',
    rendererOwner: 'apps/zero3-desktop/renderer-v2',
    codexUi: 'retired-not-mounted',
    hermesUi: 'retired-not-mounted',
    electronHost: 'pinned-hermes-temporary-build-host',
    runtimeBridges: [
      'window.zero3Codex',
      'window.zero3Workspace',
      'window.zero3GptWeb',
      'window.zero3GeminiWeb'
    ]
  }
  write(
    path.join(hermesDesktopDir, 'public', 'zero3-renderer.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )

  console.log('[Zero3 UI] Authoritative three-column renderer staged.')
  console.log('[Zero3 UI] Hermes React UI: retired / not mounted.')
  console.log('[Zero3 UI] Codex OSS UI: retired / not bundled; Codex app-server remains the Agent Kernel.')
}

if (process.argv[1]?.endsWith('apply-zero3-three-column-ui.mjs')) {
  applyZero3ThreeColumnUi()
}
