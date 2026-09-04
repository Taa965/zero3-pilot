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
        "import { ZERO3_NEW_SESSION_PROVIDER_EVENT, Zero3GptWebSection } from './zero3-gpt-web-section'"
    },
    {
      label: 'new-session provider picker dispatch',
      from:
        "                      if (isNewSession) {\n" +
        "                        $newChatProfile.set(null)\n" +
        "                      }\n\n" +
        "                      onNavigate(item)",
      to:
        "                      if (isNewSession) {\n" +
        "                        $newChatProfile.set(null)\n" +
        "                        if (typeof window.zero3GptWeb !== 'undefined') {\n" +
        "                          window.dispatchEvent(new Event(ZERO3_NEW_SESSION_PROVIDER_EVENT))\n" +
        "                          return\n" +
        "                        }\n" +
        "                      }\n\n" +
        "                      onNavigate(item)"
    },
    {
      label: 'recents-header new-session provider picker dispatch',
      from:
        "                                if (agentsGrouped) {\n" +
        "                                  openProjectCreate()\n" +
        "                                } else {\n" +
        "                                  onNewSessionInWorkspace(null)\n" +
        "                                }",
      to:
        "                                if (agentsGrouped) {\n" +
        "                                  openProjectCreate()\n" +
        "                                } else if (typeof window.zero3GptWeb !== 'undefined') {\n" +
        "                                  window.dispatchEvent(new Event(ZERO3_NEW_SESSION_PROVIDER_EVENT))\n" +
        "                                } else {\n" +
        "                                  onNewSessionInWorkspace(null)\n" +
        "                                }"
    },
    {
      label: 'always-mounted GPT Web session rows and provider picker',
      from:
        "        </SidebarGroup>\n\n" +
        "        {showSessionSections && (",
      to:
        "        </SidebarGroup>\n\n" +
        "        <Zero3GptWebSection\n" +
        "          onNewCodexSession={() => {\n" +
        "            $newChatProfile.set(null)\n" +
        "            const newSession = SIDEBAR_NAV.find(item => item.id === 'new-session')\n" +
        "            if (newSession) onNavigate(newSession)\n" +
        "          }}\n" +
        "        />\n\n" +
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
