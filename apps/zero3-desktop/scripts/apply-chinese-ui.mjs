import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) {
      continue
    }
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Chinese UI drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the localization overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3ChineseUi() {
  // Zero3 is a Chinese-first product. A fresh profile, an invalid locale, or a
  // missing display.language value must resolve to Simplified Chinese. Explicit
  // user choices such as English remain respected because normalizeLocale still
  // returns the configured supported locale when one is present.
  patchFile('src/i18n/languages.ts', [
    {
      label: 'default desktop locale',
      from: "export const DEFAULT_LOCALE: Locale = 'en'",
      to: "export const DEFAULT_LOCALE: Locale = 'zh'"
    }
  ])

  // The About page is Zero3-owned rather than upstream-owned, so localize the
  // copy here instead of leaving a permanent English-only island inside an
  // otherwise translated shell. Simplified Chinese is the primary path;
  // Traditional Chinese gets its own copy and other supported locales keep an
  // English fallback until Zero3 adds first-party translations for them.
  patchFile('src/app/settings/about-settings.tsx', [
    {
      label: 'About i18n import',
      from: "import { Info } from '@/lib/icons'\n",
      to: "import { useI18n } from '@/i18n'\nimport { Info } from '@/lib/icons'\n"
    },
    {
      label: 'About localized copy',
      from: "export function AboutSettings() {\n  const version = useStore($desktopVersion)\n",
      to: "export function AboutSettings() {\n  const version = useStore($desktopVersion)\n  const { locale } = useI18n()\n  const copy =\n    locale === 'zh'\n      ? {\n          desktopChannel: '桌面版本通道',\n          localControlPlane: '本地控制平面',\n          localControlPlaneDescription:\n            'Agent 执行、任务、定时任务、记忆、浏览器控制和电脑控制均受 Zero3 Node 策略边界管理。',\n          managedUpdates: 'Zero3 管理更新',\n          managedUpdatesDescription:\n            '桌面更新由 Zero3 Pilot 版本发布提供。本构建已禁用第三方桌面自更新和托管服务更新通道。',\n          version: '版本',\n          versionUnavailable: '无法获取桌面版本'\n        }\n      : locale === 'zh-hant'\n        ? {\n            desktopChannel: '桌面版本通道',\n            localControlPlane: '本機控制平面',\n            localControlPlaneDescription:\n              'Agent 執行、任務、排程、記憶、瀏覽器控制與電腦控制均受 Zero3 Node 策略邊界管理。',\n            managedUpdates: 'Zero3 管理更新',\n            managedUpdatesDescription:\n              '桌面更新由 Zero3 Pilot 版本發佈提供。本版本已停用第三方桌面自動更新與託管服務更新通道。',\n            version: '版本',\n            versionUnavailable: '無法取得桌面版本'\n          }\n        : {\n            desktopChannel: 'Desktop channel',\n            localControlPlane: 'Local control plane',\n            localControlPlaneDescription:\n              'Agent execution, jobs, schedules, memory, browser control and computer control stay behind the Zero3 Node policy boundary.',\n            managedUpdates: 'Zero3-managed updates',\n            managedUpdatesDescription:\n              'Desktop updates are delivered by Zero3 Pilot releases. Third-party desktop self-update and hosted-service channels are disabled in this build.',\n            version: 'Version',\n            versionUnavailable: 'Desktop version unavailable'\n          }\n"
    },
    {
      label: 'About version copy',
      from: "            {version?.appVersion ? 'Version ' + version.appVersion : 'Desktop version unavailable'}",
      to: "            {version?.appVersion ? copy.version + ' ' + version.appVersion : copy.versionUnavailable}"
    },
    {
      label: 'About section title',
      from: '<SectionHeading icon={Info} title="Desktop channel" />',
      to: '<SectionHeading icon={Info} title={copy.desktopChannel} />'
    },
    {
      label: 'About managed-update copy',
      from: "          description=\"Desktop updates are delivered by Zero3 Pilot releases. Third-party desktop self-update and hosted-service channels are disabled in this build.\"\n          title=\"Zero3-managed updates\"",
      to: '          description={copy.managedUpdatesDescription}\n          title={copy.managedUpdates}'
    },
    {
      label: 'About control-plane copy',
      from: "          description=\"Agent execution, jobs, schedules, memory, browser control and computer control stay behind the Zero3 Node policy boundary.\"\n          title=\"Local control plane\"",
      to: '          description={copy.localControlPlaneDescription}\n          title={copy.localControlPlane}'
    }
  ])

  // One of the few high-visibility upstream chat surfaces still carries raw
  // English text instead of the translation catalog. Localize it explicitly so
  // Chinese-first sessions do not fall back to English inside the transcript.
  patchFile('src/components/assistant-ui/thread/assistant-message.tsx', [
    {
      label: 'inter-agent reply localized notice',
      from: `const InterAgentCollapsedNotice: FC<{ sender: string }> = ({ sender }) => (\n  <div className=\"flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60\">\n    <span className=\"flex items-center justify-center gap-1.5\">\n      <Codicon className=\"shrink-0 text-muted-foreground/55\" name=\"arrow-small-right\" size=\"0.8125rem\" />\n      <span className=\"wrap-anywhere\">Replied to {sender}</span>\n    </span>\n    <details className=\"self-center\">\n      <summary className=\"cursor-pointer select-none text-center text-muted-foreground/45 hover:text-muted-foreground/70\">\n        show reply\n      </summary>\n      <div className=\"mt-1 max-w-[36rem] rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2 text-left text-[0.75rem] leading-5 text-foreground/85\">\n        {MESSAGE_PARTS}\n      </div>\n    </details>\n  </div>\n)`,
      to: `const InterAgentCollapsedNotice: FC<{ sender: string }> = ({ sender }) => {\n  const { locale } = useI18n()\n  const repliedTo = locale === 'zh' ? '已回复' : locale === 'zh-hant' ? '已回覆' : 'Replied to'\n  const showReply = locale === 'zh' ? '显示回复' : locale === 'zh-hant' ? '顯示回覆' : 'show reply'\n\n  return (\n    <div className=\"flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60\">\n      <span className=\"flex items-center justify-center gap-1.5\">\n        <Codicon className=\"shrink-0 text-muted-foreground/55\" name=\"arrow-small-right\" size=\"0.8125rem\" />\n        <span className=\"wrap-anywhere\">\n          {repliedTo} {sender}\n        </span>\n      </span>\n      <details className=\"self-center\">\n        <summary className=\"cursor-pointer select-none text-center text-muted-foreground/45 hover:text-muted-foreground/70\">\n          {showReply}\n        </summary>\n        <div className=\"mt-1 max-w-[36rem] rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2 text-left text-[0.75rem] leading-5 text-foreground/85\">\n          {MESSAGE_PARTS}\n        </div>\n      </details>\n    </div>\n  )\n}`
    }
  ])
}
