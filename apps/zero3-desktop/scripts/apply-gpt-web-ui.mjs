import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceFile = path.join(repoRoot, 'apps', 'zero3-desktop', 'gpt-web-ui', 'gpt-web-section.tsx')
const targetFile = path.join(hermesDesktopDir, 'src', 'app', 'chat', 'sidebar', 'zero3-gpt-web-section.tsx')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 GPT Web UI overlay drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes chat/sidebar boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

export function applyZero3GptWebUi() {
  if (!fs.statSync(sourceFile).isFile()) throw new Error(`Zero3 GPT Web UI source template missing: ${sourceFile}`)
  write(targetFile, read(sourceFile))

  patchFile('src/app/chat/sidebar/index.tsx', [
    {
      label: 'GPT Web sidebar section import',
      from: "import { SidebarSessionsSection, VIRTUALIZE_THRESHOLD } from './sessions-section'",
      to:
        "import { SidebarSessionsSection, VIRTUALIZE_THRESHOLD } from './sessions-section'\n" +
        "import { Zero3GptWebSection } from './zero3-gpt-web-section'"
    },
    {
      label: 'GPT Web section before Codex session search/list',
      from:
        "        </SidebarGroup>\n\n" +
        "        {showSessionSections && (",
      to:
        "        </SidebarGroup>\n\n" +
        "        <Zero3GptWebSection />\n\n" +
        "        {showSessionSections && ("
    }
  ])

  patchFile('src/app/chat/index.tsx', [
    {
      label: 'primary Chat surface native-view host marker',
      from:
        "      data-chat-surface=\"\"\n" +
        "      data-chat-unfocused={surfaceFocused ? undefined : ''}",
      to:
        "      data-chat-surface=\"\"\n" +
        "      data-zero3-gpt-web-host={isPrimary ? '' : undefined}\n" +
        "      data-chat-unfocused={surfaceFocused ? undefined : ''}"
    }
  ])
}
