# Zero3 Desktop v3 (Hermes shell migration)

This directory is the migration harness for the next Zero3 Pilot desktop architecture.

Zero3 uses the pinned open-source Hermes Desktop Electron/React implementation as a GUI foundation while keeping Zero3 Pilot Node as the local control plane. Hermes is an upstream implementation detail, not the product identity or commercial relationship presented to the user.

## Pinned upstreams

The repository pins three source trees as Git submodules:

- `upstream/hermes-agent` — desktop shell / interaction architecture.
- `upstream/codex` — open-source Codex CLI and `app-server` integration source.
- `upstream/deepseek-harness` — DeepSeek Harness engine/plugin/UI reference and future adapter source.

Exact SHAs live in `scripts/config.mjs`; preparation refuses to continue when a checked-out submodule does not match its pin.

## Zero3 shell policy

`npm run prepare` applies two deterministic overlays to the pinned Hermes Desktop source:

1. **Zero3 product branding** — app identity, wordmark, icons, installer metadata and selected UI copy become Zero3 Pilot.
2. **Zero3 product policy** — upstream commercial surfaces that do not belong in Zero3 are disabled while reusable open-source Agent functionality is retained.

The current policy removes these Hermes/Nous product surfaces from the Zero3 user experience:

- Nous Portal as the featured/default provider.
- first-run account-login funnel; onboarding starts with API keys and local/custom endpoints instead.
- the Providers → Accounts login page.
- Billing / subscription / credit navigation and the in-chat billing CTA banner.
- Nous diagnostic-upload dialog.
- Nous Cloud Portal/Discord recovery funnel; failures fall back to generic gateway recovery.
- Hermes product/release website links in About; links point back to the Zero3 repository instead.

Provider authentication mechanics that are useful outside the Hermes commercial product (for example API keys, custom OpenAI-compatible endpoints, and generic gateway authentication) remain available. Zero3 can later expose selected OAuth integrations under its own model/Agent settings without restoring Hermes commercial UI.

## Current migration stage

The current compatibility stage does the following:

1. Initialize and verify pinned upstream repositories.
2. Apply Zero3 branding and shell-policy overlays.
3. Use an isolated Hermes home under the Zero3 data area instead of mutating the user's normal Hermes profile.
4. Install the Zero3 Pilot skill into that isolated profile.
5. Start/reuse `zero3-pilot-node` on loopback before launching desktop development sessions.
6. Let Zero3-specific jobs, automation, memory, browser control, computer control, and Agent dispatch continue through the Zero3 Node policy boundary.

Hermes still owns the compatibility chat transport in this stage. A later stage replaces that bridge with a direct Zero3 desktop transport while retaining the reusable Electron/React shell architecture.

## Commands

From this directory:

```powershell
npm run prepare
npm run dev
npm run typecheck
npm run dist:win
```

`npm run prepare` initializes upstreams, verifies fixed SHAs, applies both Zero3 overlays, writes the build provenance stamp, and copies `.agents/skills/zero3-pilot/SKILL.md` into the isolated profile.

`npm run dev` additionally builds/starts the local Zero3 Node when needed and launches the pinned desktop process with:

- `HERMES_HOME` redirected to Zero3's isolated data directory.
- `HERMES_DESKTOP_HERMES_ROOT` pinned to `upstream/hermes-agent`.
- `ZERO3_PILOT_NODE_PORT` forwarded to the desktop/skill environment.

`npm run reset` resets the Hermes submodule back to the pinned SHA and removes generated overlay state. It is destructive to tracked changes inside the Hermes submodule.

## Safety rule for upstream modifications

Do not edit the pinned upstream submodules casually. `prepare-upstream.mjs` maintains an explicit allowlist of files owned by the Zero3 branding/product-policy overlays. Any other tracked upstream change causes preparation to fail instead of silently overwriting developer work.

The shell-policy transformations are implemented in `scripts/apply-shell-policy.mjs`. Every replacement is fail-closed: if the pinned upstream source no longer contains the expected structure, preparation stops and requires an explicit review before the upstream pin can move.

## Legacy desktop path

`apps/desktop` is the previous Rust/Tao/Wry desktop path. It remains temporarily for installer compatibility and rollback while the v3 shell proves itself. It is not the target architecture and should not receive new product UI features.
