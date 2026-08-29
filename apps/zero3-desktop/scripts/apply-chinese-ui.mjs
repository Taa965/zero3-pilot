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
  // missing display.language value must resolve to Simplified Chinese. The
  // pinned Hermes runtime can materialize `display.language: en` before the
  // Zero3 renderer has ever shown a language picker, so an unmarked English
  // value is treated as the upstream legacy default. Once the user explicitly
  // chooses English, localeConfigValue records that choice and future launches
  // keep English. This also prevents the first paint from flashing English.
  patchFile('src/i18n/languages.ts', [
    {
      label: 'default desktop locale',
      from: "export const DEFAULT_LOCALE: Locale = 'en'",
      to: "export const DEFAULT_LOCALE: Locale = 'zh'"
    },
    {
      label: 'explicit English language migration policy',
      from: `export function normalizeLocale(value: unknown): Locale {\n  if (typeof value !== 'string') {\n    return DEFAULT_LOCALE\n  }\n\n  return LOCALE_ALIASES[normalize(value)] ?? DEFAULT_LOCALE\n}\n\nexport function isSupportedLocaleValue(value: unknown): boolean {\n  return typeof value === 'string' && LOCALE_ALIASES[normalize(value)] != null\n}\n\nexport function localeConfigValue(locale: Locale): string {\n  return LOCALE_OPTIONS.find(item => item.id === locale)?.configValue ?? DEFAULT_LOCALE\n}`,
      to: `const ZERO3_EXPLICIT_LANGUAGE_KEY = 'zero3-explicit-language-v1'\n\nfunction hasZero3ExplicitLanguageChoice(): boolean {\n  if (typeof window === 'undefined') return false\n  try {\n    return window.localStorage.getItem(ZERO3_EXPLICIT_LANGUAGE_KEY) === '1'\n  } catch {\n    return false\n  }\n}\n\nfunction markZero3ExplicitLanguageChoice(): void {\n  if (typeof window === 'undefined') return\n  try {\n    window.localStorage.setItem(ZERO3_EXPLICIT_LANGUAGE_KEY, '1')\n  } catch {\n    // Language still changes for the current session if storage is unavailable.\n  }\n}\n\nexport function normalizeLocale(value: unknown): Locale {\n  if (typeof value !== 'string') {\n    return DEFAULT_LOCALE\n  }\n\n  const locale = LOCALE_ALIASES[normalize(value)] ?? DEFAULT_LOCALE\n  if (locale === 'en' && !hasZero3ExplicitLanguageChoice()) {\n    return DEFAULT_LOCALE\n  }\n\n  return locale\n}\n\nexport function isSupportedLocaleValue(value: unknown): boolean {\n  return typeof value === 'string' && LOCALE_ALIASES[normalize(value)] != null\n}\n\nexport function localeConfigValue(locale: Locale): string {\n  if (locale === 'en') {\n    markZero3ExplicitLanguageChoice()\n  }\n  return LOCALE_OPTIONS.find(item => item.id === locale)?.configValue ?? DEFAULT_LOCALE\n}`
    }
  ])

  // Keep the onboarding provider catalog Chinese-first without translating
  // provider/model brand names. Generic product copy such as the local endpoint
  // label and dynamically derived API-access descriptions follows the selected
  // UI locale.
  patchFile('src/components/onboarding/index.tsx', [
    {
      label: 'localized API-key provider catalog',
      from: `function useApiKeyCatalog(): ApiKeyOption[] {\n  const [rows, setRows] = useState<ModelOptionProvider[]>([])\n\n  useEffect(() => {\n    let cancelled = false\n\n    // Best-effort — on failure the curated defaults still render. Wrapped in\n    // Promise.resolve().then so a synchronous throw (e.g. no desktop bridge in\n    // tests) is funneled into the same .catch instead of escaping.\n    void Promise.resolve()\n      .then(() => getGlobalModelOptions({ includeUnconfigured: true, explicitOnly: false }))\n      .then(res => {\n        if (!cancelled) {\n          setRows(res.providers ?? [])\n        }\n      })\n      .catch(() => {\n        // Ignore — fall back to the curated API_KEY_OPTIONS only.\n      })\n\n    return () => {\n      cancelled = true\n    }\n  }, [])\n\n  return useMemo(() => {\n    const curatedByEnv = new Map(API_KEY_OPTIONS.map(o => [o.envKey, o]))\n    const derived: ApiKeyOption[] = []\n    const seenEnv = new Set<string>(API_KEY_OPTIONS.map(o => o.envKey))\n\n    for (const row of rows) {\n      // Only api_key providers can be activated with a pasted key. Skip OAuth /\n      // external / managed flows and anything missing an env var to write to.\n      if (row.auth_type && row.auth_type !== 'api_key') {\n        continue\n      }\n\n      const envKey = row.key_env\n\n      if (!envKey || seenEnv.has(envKey)) {\n        continue\n      }\n\n      seenEnv.add(envKey)\n      derived.push({\n        id: row.slug,\n        name: row.name,\n        envKey,\n        description: \`Direct API access to \${row.name}.\`,\n        docsUrl: ''\n      })\n    }\n\n    // Curated first (recommended order), then the rest alphabetically so the\n    // long tail is scannable.\n    derived.sort((a, b) => a.name.localeCompare(b.name))\n\n    return [...API_KEY_OPTIONS.filter(o => curatedByEnv.has(o.envKey)), ...derived]\n  }, [rows])\n}`,
      to: `function useApiKeyCatalog(): ApiKeyOption[] {\n  const { locale } = useI18n()\n  const [rows, setRows] = useState<ModelOptionProvider[]>([])\n\n  useEffect(() => {\n    let cancelled = false\n\n    // Best-effort — on failure the curated defaults still render. Wrapped in\n    // Promise.resolve().then so a synchronous throw (e.g. no desktop bridge in\n    // tests) is funneled into the same .catch instead of escaping.\n    void Promise.resolve()\n      .then(() => getGlobalModelOptions({ includeUnconfigured: true, explicitOnly: false }))\n      .then(res => {\n        if (!cancelled) {\n          setRows(res.providers ?? [])\n        }\n      })\n      .catch(() => {\n        // Ignore — fall back to the curated API_KEY_OPTIONS only.\n      })\n\n    return () => {\n      cancelled = true\n    }\n  }, [])\n\n  return useMemo(() => {\n    const localizedCurated = API_KEY_OPTIONS.map(option =>\n      option.id === 'local'\n        ? {\n            ...option,\n            name:\n              locale === 'zh'\n                ? '本地 / 自定义端点'\n                : locale === 'zh-hant'\n                  ? '本機 / 自訂端點'\n                  : option.name\n          }\n        : option\n    )\n    const curatedByEnv = new Map(localizedCurated.map(o => [o.envKey, o]))\n    const derived: ApiKeyOption[] = []\n    const seenEnv = new Set<string>(localizedCurated.map(o => o.envKey))\n\n    for (const row of rows) {\n      // Only api_key providers can be activated with a pasted key. Skip OAuth /\n      // external / managed flows and anything missing an env var to write to.\n      if (row.auth_type && row.auth_type !== 'api_key') {\n        continue\n      }\n\n      const envKey = row.key_env\n\n      if (!envKey || seenEnv.has(envKey)) {\n        continue\n      }\n\n      seenEnv.add(envKey)\n      derived.push({\n        id: row.slug,\n        name: row.name,\n        envKey,\n        description:\n          locale === 'zh'\n            ? \`直接通过 API 访问 \${row.name}。\`\n            : locale === 'zh-hant'\n              ? \`直接透過 API 存取 \${row.name}。\`\n              : \`Direct API access to \${row.name}.\`,\n        docsUrl: ''\n      })\n    }\n\n    // Curated first (recommended order), then the rest alphabetically so the\n    // long tail is scannable.\n    derived.sort((a, b) => a.name.localeCompare(b.name))\n\n    return [...localizedCurated.filter(o => curatedByEnv.has(o.envKey)), ...derived]\n  }, [locale, rows])\n}`
    }
  ])

  // Remove a high-visibility English fallback that still ships inside the
  // upstream Simplified Chinese catalog.
  patchFile('src/i18n/zh.ts', [
    {
      label: 'gateway reconnect detail Chinese copy',
      from: `      gatewayConnectionLostDetail:\n        'Still retrying in the background. You can keep reading and drafting — open Gateway settings if this persists.',`,
      to: `      gatewayConnectionLostDetail:\n        '正在后台持续重试。你可以继续阅读和编辑；如果问题持续存在，请打开“网关设置”检查连接。',`
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
