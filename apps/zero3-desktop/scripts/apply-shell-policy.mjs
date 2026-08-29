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

export function applyZero3ShellPolicy() {
  // Zero3 owns the product relationship. Keep the useful Hermes provider and
  // gateway machinery, but do not surface Hermes/Nous account sales funnels,
  // subscriptions, billing recovery, hosted-cloud support links, or diagnostic
  // uploads in the Zero3 desktop product.
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
      from: `      {
        active: activeView === 'billing',
        icon: BarChart3,
        id: 'billing',
        label: t.settings.nav.billing,
        onSelect: () => setActiveView('billing')
      },
`,
      to: `      // Zero3 shell policy: no upstream billing/subscription navigation.
`
    },
    {
      label: 'provider accounts navigation item',
      from: `          {
            active: activeView === 'providers' && providerView === 'accounts',
            icon: codiconIcon('account'),
            id: 'pview:accounts',
            label: t.settings.nav.providerAccounts,
            onSelect: () => openProviderView('accounts')
          },
`,
      to: `          // Zero3 shell policy: upstream account-login surface is hidden.
`
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
      from: `  if (billing && sessionId && billing.sessionId === sessionId) {
    sections.push({ key: 'billing', node: <BillingBanner sessionId={sessionId} /> })
  }
`,
      to: `  // Zero3 shell policy: no upstream billing / add-credits CTA in chat.
`
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'billing settings redirect',
      from: '    if (billingSettingsRequest > 0) {',
      to: '    if (false && billingSettingsRequest > 0) { // Zero3 shell policy: upstream billing route disabled.'
    },
    {
      label: 'Nous diagnostics dialog host',
      from: '      <SendDiagnosticsHost />',
      to: '      {false && <SendDiagnosticsHost />}'
    }
  ])

  patchFile('src/components/boot-failure-overlay.tsx', [
    {
      label: 'Nous Cloud recovery branch',
      from: '  const cloudDown = Boolean(boot.isCloudBackendDown)',
      to: '  const cloudDown = false // Zero3 shell policy: never expose upstream Portal/Discord recovery funnel.'
    }
  ])

  patchFile('src/app/settings/about-settings.tsx', [
    {
      label: 'upstream release notes URL',
      from: "const RELEASE_NOTES_URL = 'https://github.com/NousResearch/hermes-agent/releases'",
      to: "const RELEASE_NOTES_URL = 'https://github.com/Taa965/zero3-pilot'"
    },
    {
      label: 'upstream installer URL',
      from: "const INSTALLER_URL = 'https://hermes-agent.nousresearch.com/'",
      to: "const INSTALLER_URL = 'https://github.com/Taa965/zero3-pilot'"
    }
  ])
}
