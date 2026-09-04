import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'zero3-ui')
const targetDir = path.join(hermesDesktopDir, 'src', 'zero3-ui')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function copyOwnedRenderer() {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['App.tsx', 'ProductApp.tsx', 'HandoffDock.tsx', 'styles.css', 'layout.css', 'handoff.css']) {
    const source = path.join(sourceDir, file)
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Zero3 owned renderer source is missing: ${source}`)
    }
    write(path.join(targetDir, file), read(source))
  }
}

function replaceRendererEntrypoint() {
  const entry = String.raw`import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ProductApp } from './zero3-ui/ProductApp'
import './zero3-ui/styles.css'
import './zero3-ui/layout.css'
import './zero3-ui/handoff.css'

const root = document.getElementById('root')
if (!root) throw new Error('Zero3 renderer root element is missing')

createRoot(root).render(
  <StrictMode>
    <ProductApp />
  </StrictMode>
)
`
  write(path.join(hermesDesktopDir, 'src', 'main.tsx'), entry)
}

function configureOwnedRendererTooling() {
  const tsconfig = {
    extends: './tsconfig.json',
    compilerOptions: { noEmit: true },
    include: ['src/vite-env.d.ts', 'src/main.tsx', 'src/zero3-ui/**/*.ts', 'src/zero3-ui/**/*.tsx'],
    exclude: []
  }
  write(path.join(hermesDesktopDir, 'tsconfig.zero3-renderer.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)

  const packagePath = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(read(packagePath))
  packageJson.scripts = packageJson.scripts ?? {}
  packageJson.scripts.typecheck = 'tsc -p tsconfig.zero3-renderer.json --noEmit && tsc -p tsconfig.electron.json --noEmit'
  packageJson.scripts.lint = 'eslint src/main.tsx src/zero3-ui/ electron/'
  packageJson.scripts.fmt = "prettier --write 'src/main.tsx' 'src/zero3-ui/**/*.{ts,tsx,css}' 'electron/**/*.ts'"
  write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

function recordRendererProvenance() {
  const file = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  const current = fs.existsSync(file) ? JSON.parse(read(file)) : {}
  current.productRenderer = 'zero3-owned-three-column-v1'
  current.hermesRenderer = 'disabled'
  current.codexUi = 'disabled-app-server-only'
  current.electronHost = 'pinned-hermes-electron-temporary'
  write(file, `${JSON.stringify(current, null, 2)}\n`)
}

function assertSoleRenderer() {
  const entry = read(path.join(hermesDesktopDir, 'src', 'main.tsx'))
  if (!entry.includes("import { ProductApp } from './zero3-ui/ProductApp'")) {
    throw new Error('Zero3 three-column renderer is not the desktop renderer entrypoint')
  }
  if (/from ['\"]\.\/app|<RouterProvider|<Hermes/i.test(entry)) {
    throw new Error('Legacy Hermes renderer leaked back into the Zero3 desktop entrypoint')
  }
  const productApp = read(path.join(targetDir, 'ProductApp.tsx'))
  if (!productApp.includes('<App />') || !productApp.includes('<HandoffDock />')) {
    throw new Error('Zero3 product renderer lost the real session workspace or task-handoff surface')
  }
  const packageJson = JSON.parse(read(path.join(hermesDesktopDir, 'package.json')))
  if (!String(packageJson.scripts?.typecheck ?? '').includes('tsconfig.zero3-renderer.json')) {
    throw new Error('Retired Hermes renderer is still part of the Zero3 renderer typecheck surface')
  }
}

export function applyZero3OwnedUi() {
  copyOwnedRenderer()
  replaceRendererEntrypoint()
  configureOwnedRendererTooling()
  recordRendererProvenance()
  assertSoleRenderer()
  console.log('Zero3 owned three-column renderer is the sole desktop UI entrypoint and renderer typecheck surface; real task handoff is included; Hermes/Codex product UIs are disabled.')
}

if (process.argv[1]?.endsWith('apply-zero3-owned-ui.mjs')) applyZero3OwnedUi()
