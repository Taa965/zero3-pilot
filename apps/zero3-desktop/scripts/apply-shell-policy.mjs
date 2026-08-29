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
        `Zero3 shell policy drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

function replaceFile(relativePath, marker, content) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  const current = fs.readFileSync(file, 'utf8')

  if (current === content) {
    return
  }
  if (!current.includes(marker)) {
    throw new Error(
      `Zero3 shell policy drift in ${relativePath}: replacement marker not found. ` +
        'The pinned Hermes Desktop source changed; review the overlay before updating the pin.'
    )
  }

  fs.writeFileSync(file, content)
}

const ZERO3_ABOUT = `import { useStore } from '@nanostores/react'\nimport { useEffect } from 'react'\n\nimport { BrandMark } from '@/components/brand-mark'\nimport { Info } from '@/lib/icons'\nimport { $desktopVersion, refreshDesktopVersion } from '@/store/updates'\n\nimport { ListRow, SectionHeading, SettingsContent } from './primitives'\n\nexport function AboutSettings() {\n  const version = useStore($desktopVersion)\n\n  useEffect(() => {\n    void refreshDesktopVersion()\n  }, [])\n\n  return (\n    <SettingsContent>\n      <div className=\"flex flex-col items-center gap-3 pt-6 pb-2 text-center\">\n        <BrandMark className=\"size-16\" />\n        <div>\n          <h2 className=\"text-lg font-semibold tracking-tight\">Zero3 Pilot</h2>\n          <p className=\"mt-1 text-xs text-muted-foreground\">\n            {version?.appVersion ? 'Version ' + version.appVersion : 'Desktop version unavailable'}\n          </p>\n        </div>\n      </div>\n\n      <div className=\"mx-auto mt-4 w-full max-w-2xl\">\n        <SectionHeading icon={Info} title=\"Desktop channel\" />\n        <ListRow\n          description=\"Desktop updates are delivered by Zero3 Pilot releases. Third-party desktop self-update and hosted-service channels are disabled in this build.\"\n          title=\"Zero3-managed updates\"\n        />\n        <ListRow\n          description=\"Agent execution, jobs, schedules, memory, browser control and computer control stay behind the Zero3 Node policy boundary.\"\n          title=\"Local control plane\"\n        />\n      </div>\n    </SettingsContent>\n  )\n}\n`

export function applyZero3ShellPolicy() {
  // Zero3 owns the product relationship. Keep the useful Hermes provider and
  // gateway machinery, but do not surface Hermes/Nous account sales funnels,
  // subscriptions, billing recovery, hosted-cloud support links, diagnostics
  // uploads, or upstream self-update controls in the Zero3 desktop product.
  patchFile('src/components/brand-mark.tsx', [
    {
      label: 'Nous brand image',
      from: "src={assetPath('nous-girl.jpg')}",
      to: "src={assetPath('zero3-pilot.png')}"
    }
  ])

  patchFile('src/app/settings/index.tsx', [
    {
      label: 'account icon helper import',
      from: "import { codiconIcon } from '@/components/ui/codicon'\n",
      to: '// Zero3 shell policy: upstream account-login icon helper removed.\n'
    },
    {
      label: 'billing icon import',
      from: '  BarChart3,\n',
      to: '  // Zero3 shell policy: upstream billing icon removed.\n'
    },
    {
      label: 'billing route entry',
      from: "  'billing',\n",
      to: "  // Zero3 shell policy: upstream billing page disabled.\n"
    },
    {
      label: 'provider default subview',
      from: "  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')",
      to: "  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'keys')"
    },
    {
      label: 'billing navigation item',
      from: `      {\n        active: activeView === 'billing',\n        icon: BarChart3,\n        id: 'billing',\n        label: t.settings.nav.billing,\n        onSelect: () => setActiveView('billing')\n      },\n`,
      to: `      // Zero3 shell policy: no upstream billing/subscription navigation.\n`
    },
    {
      label: 'provider accounts navigation item',
      from: `          {\n            active: activeView === 'providers' && providerView === 'accounts',\n            icon: codiconIcon('account'),\n            id: 'pview:accounts',\n            label: t.settings.nav.providerAccounts,\n            onSelect: () => openProviderView('accounts')\n          },\n`,
      to: `          // Zero3 shell policy: upstream account-login surface is hidden.\n`
    }
  ])

  patchFile('src/app/settings/providers-settings.tsx', [
    {
      label: 'OAuth provider ordering',
      from: '  const ordered = useMemo(() => sortProviders(providers), [providers])',
      to: "  const ordered = useMemo(() => sortProviders(providers).filter(provider => provider.id !== 'nous'), [providers])"
    },
    {
      label: 'accounts deep-link coercion',
      from: "  const showApiKeys = view === 'keys' || (!hasOauth && view !== 'custom-endpoints')",
      to: "  const showApiKeys = view === 'keys' || view === 'accounts' || (!hasOauth && view !== 'custom-endpoints')"
    }
  ])

  patchFile('src/store/onboarding.ts', [
    {
      label: 'first-run onboarding mode',
      from: "  mode: 'oauth',",
      to: "  mode: 'apikey',"
    },
    {
      label: 'provider refresh onboarding mode',
      from: "      patch({ mode: providers.length > 0 ? 'oauth' : 'apikey', providers })",
      to: "      patch({ mode: 'apikey', providers })"
    }
  ])

  patchFile('src/components/onboarding/index.tsx', [
    {
      label: 'featured Nous provider id',
      from: "export const FEATURED_ID = 'nous'",
      to: "export const FEATURED_ID = '__zero3_disabled__'"
    },
    {
      label: 'first-run provider ordering',
      from: '  const ordered = useMemo(() => (providers ? sortProviders(providers) : []), [providers])',
      to: "  const ordered = useMemo(() => (providers ? sortProviders(providers).filter(provider => provider.id !== 'nous') : []), [providers])"
    },
    {
      label: 'OAuth back-link gate',
      from: '  const hasOauth = ordered.length > 0',
      to: '  const hasOauth = false // Zero3 shell policy: API-key/custom-endpoint onboarding only.'
    },
    {
      label: 'local endpoint docs link',
      from: "    docsUrl: 'https://github.com/NousResearch/hermes-agent#bring-your-own-endpoint',",
      to: "    docsUrl: 'https://github.com/Taa965/zero3-pilot',"
    }
  ])

  patchFile('src/app/chat/composer/status-stack/index.tsx', [
    {
      label: 'billing banner import',
      from: "import { BillingBanner } from '@/components/billing-banner'\n",
      to: '// Zero3 shell policy: upstream billing banner removed.\n'
    },
    {
      label: 'billing store import',
      from: "import { $billingBlock } from '@/store/billing-block'\n",
      to: '// Zero3 shell policy: upstream billing store surface removed.\n'
    },
    {
      label: 'billing store subscription',
      from: '  const billing = useStore($billingBlock)\n',
      to: '  // Zero3 shell policy: no billing-wall subscription in the product shell.\n'
    },
    {
      label: 'billing wall renderer',
      from: `  if (billing && sessionId && billing.sessionId === sessionId) {\n    sections.push({ key: 'billing', node: <BillingBanner sessionId={sessionId} /> })\n  }\n`,
      to: `  // Zero3 shell policy: no upstream billing / add-credits CTA in chat.\n`
    }
  ])

  patchFile('src/components/assistant-ui/thread/assistant-message.tsx', [
    {
      label: 'diagnostics upload icon import',
      from: '  Upload,\n',
      to: '  // Zero3 shell policy: upstream diagnostics-upload icon removed.\n'
    },
    {
      label: 'diagnostics request import',
      from: "import { requestSendDiagnostics } from '@/store/send-diagnostics'\n",
      to: '// Zero3 shell policy: upstream diagnostics upload removed.\n'
    },
    {
      label: 'send diagnostics action',
      from: `      <button className=\"aui-error-action\" onClick={() => requestSendDiagnostics(diagnosticsText())} type=\"button\">\n        <Upload className=\"size-3\" />\n        {copy.errorSendDiagnostics}\n      </button>\n`,
      to: `      {/* Zero3 shell policy: local logs/copy remain; third-party diagnostics upload is removed. */}\n`
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'diagnostics host import',
      from: "import { SendDiagnosticsHost } from '@/components/send-diagnostics-dialog'\n",
      to: '// Zero3 shell policy: upstream diagnostics host removed.\n'
    },
    {
      label: 'updates overlay import',
      from: "import { UpdatesOverlay } from '../updates-overlay'\n",
      to: '// Zero3 shell policy: upstream desktop updates overlay removed.\n'
    },
    {
      label: 'billing settings redirect',
      from: '    if (billingSettingsRequest > 0) {',
      to: '    if (false && billingSettingsRequest > 0) { // Zero3 shell policy: upstream billing route disabled.'
    },
    {
      label: 'Nous diagnostics dialog host',
      from: '      <SendDiagnosticsHost />',
      to: '      {/* Zero3 shell policy: no third-party diagnostics upload host. */}'
    },
    {
      label: 'updates overlay host',
      from: '      <UpdatesOverlay />',
      to: '      {/* Zero3 shell policy: Zero3 releases own desktop updates. */}'
    }
  ])

  patchFile('src/app/contrib/hooks/use-desktop-integrations.ts', [
    {
      label: 'upstream updater import',
      from: "import { openUpdatesWindow, startUpdatePoller, stopUpdatePoller } from '@/store/updates'\n",
      to: '// Zero3 shell policy: upstream desktop update polling disabled.\n'
    },
    {
      label: 'desktop updater integration effect',
      from: `  // Update polling — populates $desktopVersion/$updateStatus, which feed the\n  // statusbar version pill and the update toasts. Also honors the main\n  // process's \"open updates\" menu request.\n  useEffect(() => {\n    startUpdatePoller()\n    // Background MCP health: HTTP/SSE servers only (never spawns stdio),\n    // notifies on transitions into needs-auth/error with a Sign in action.\n    startMcpHealthChecker()\n    const unsubscribe = window.hermesDesktop?.onOpenUpdatesRequested?.(() => openUpdatesWindow())\n\n    return () => {\n      unsubscribe?.()\n      stopUpdatePoller()\n      stopMcpHealthChecker()\n    }\n  }, [])\n`,
      to: `  // Zero3 owns desktop release/update policy. Keep MCP health checks, but\n  // never poll or apply the pinned upstream desktop's self-update channel.\n  useEffect(() => {\n    startMcpHealthChecker()\n\n    return () => {\n      stopMcpHealthChecker()\n    }\n  }, [])\n`
    }
  ])

  patchFile('src/app/command-palette/index.tsx', [
    {
      label: 'upstream update action import',
      from: '  requestActiveUpdate\n',
      to: '  // Zero3 shell policy: upstream update action removed.\n'
    },
    {
      label: 'provider accounts command palette entry',
      from: `  {\n    icon: Zap,\n    keywords: ['accounts', 'sign in', 'oauth', 'login', 'subscription', 'models', 'anthropic', 'openai'],\n    labelKey: 'providerAccounts',\n    tab: 'providers&pview=accounts'\n  },\n`,
      to: `  // Zero3 shell policy: no upstream account-login destination.\n`
    },
    {
      label: 'upstream update command',
      from: `          {\n            detail: updateVersionLabel,\n            icon: Download,\n            id: 'cc-update-hermes',\n            keywords: ['update', 'upgrade', 'hermes', 'version', 'system', 'restart'],\n            label: cc.updateHermes,\n            run: () => requestActiveUpdate()\n          },\n`,
      to: `          // Zero3 shell policy: desktop updates are distributed by Zero3 releases.\n`
    }
  ])

  patchFile('src/app/context-menu/app-context-menu.tsx', [
    {
      label: 'context menu updater import',
      from: "import { requestActiveUpdate } from '@/store/updates'\n",
      to: '// Zero3 shell policy: upstream desktop update action removed.\n'
    },
    {
      label: 'context menu updater action',
      from: `    [\n      <Item\n        icon=\"cloud-download\"\n        key=\"shell-update\"\n        label={t.commandCenter.updateHermes}\n        onSelect={requestActiveUpdate}\n      />\n    ]\n`,
      to: `    []\n`
    }
  ])

  patchFile('src/app/settings/connections-registry.tsx', [
    {
      label: 'Nous Cloud new-connection kind',
      from: "            {(editor.id ? ([editor.kind] as const) : (['local', 'cloud', 'remote', 'ssh'] as const)).map(kind => (",
      to: "            {(editor.id ? ([editor.kind] as const) : (['local', 'remote', 'ssh'] as const)).map(kind => ("
    }
  ])

  patchFile('src/store/updates.ts', [
    {
      label: 'backend contract auto-update action',
      from: `    action: {\n      label: translateNow('notifications.updateHermes'),\n      onClick: () => {\n        snoozeSkewToast()\n        void applyBackendUpdate()\n      }\n    },\n`,
      to: `    // Zero3 shell policy: warn about runtime skew but never self-update the pinned upstream.\n`
    }
  ])

  patchFile('src/components/boot-failure-overlay.tsx', [
    {
      label: 'Nous Cloud recovery branch',
      from: '  const cloudDown = Boolean(boot.isCloudBackendDown)',
      to: '  const cloudDown = false // Zero3 shell policy: never expose upstream Portal/Discord recovery funnel.'
    }
  ])

  replaceFile('src/app/settings/about-settings.tsx', "const RELEASE_NOTES_URL = 'https://github.com/NousResearch/hermes-agent/releases'", ZERO3_ABOUT)
}
