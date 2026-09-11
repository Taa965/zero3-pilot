import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './scripts/config.mjs'

const uiV2Dir = path.join(repoRoot, 'apps', 'zero3-desktop', 'ui-v2')
const targetDir = path.join(hermesDesktopDir, 'src', 'zero3-ui-v2')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

export function applyZero3UiV2() {
  console.log('Applying Zero3 UI v2 Mount Seam...')

  // 1. Copy UI bundle to target directory so Vite can resolve it
  function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
    for (const file of fs.readdirSync(src)) {
      const srcPath = path.join(src, file)
      const destPath = path.join(dest, file)
      if (fs.statSync(srcPath).isDirectory()) {
        copyDirRecursive(srcPath, destPath)
      } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
        write(destPath, read(srcPath))
      }
    }
  }
  
  copyDirRecursive(uiV2Dir, targetDir)
  // Share browser-safe contracts and transition rules with the authoritative runtime.
  // Never copy the Node runtime/store into the renderer bundle.
  for (const file of ['contracts.ts', 'state-machine.ts']) {
    const source = read(path.join(repoRoot, 'apps', 'zero3-desktop', 'execution-runtime', file))
    write(path.join(hermesDesktopDir, 'src', 'execution-runtime', file), source.replace(/(from ['"]\.[^'"]+)\.ts(['"])/g, '$1$2'))
  }
  
  // Create an index file to export the shell
  write(path.join(targetDir, 'index.ts'), "export { Zero3AppShell } from './shell/Zero3AppShell'")

  // 2. Patch main.tsx to mount Zero3AppShell instead of App
  const mainTsxPath = path.join(hermesDesktopDir, 'src', 'main.tsx')
  let mainTsx = read(mainTsxPath)

  const originalAppImport = "import App from './app'"
  if (!mainTsx.includes(originalAppImport)) {
    throw new Error('Zero3 UI Mount Seam failed: Could not find App import in main.tsx. Upstream may have drifted.')
  }

  // 3. Inject the seam
  if (!mainTsx.includes('Zero3AppShell')) {
    mainTsx = mainTsx.replace(
      originalAppImport,
      "import App from './app'\nimport { Zero3AppShell } from './zero3-ui-v2'"
    )

    const routerStart = '<HashRouter useTransitions={false}>'
    const routerEnd = '</HashRouter>'
    const appElement = '<App />'

    if (!mainTsx.includes(appElement)) {
      throw new Error('Zero3 UI Mount Seam failed: Could not find <App /> in main.tsx')
    }

    // Wrap the app to render our shell instead. The user document specifies that we should mount Zero3AppShell instead of replacing the entire React DOM.
    mainTsx = mainTsx.replace(
      appElement,
      '<Zero3AppShell />\n                    {/* <App /> */}'
    )

    write(mainTsxPath, mainTsx)
  }

  console.log('Zero3 UI v2 Mount Seam applied successfully.')
}

// If run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  applyZero3UiV2()
}
