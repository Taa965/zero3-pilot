# Zero3 Desktop v3 (Hermes shell migration)

This directory is the migration harness for the next Zero3 Pilot desktop architecture.

The product shell is no longer intended to be the custom Tao/Wry dashboard and is no longer intended to depend on the proprietary Codex Desktop/AppX. Instead, Zero3 uses the pinned open-source Hermes Desktop Electron/React implementation as its GUI foundation while keeping Zero3 Pilot Node as the local control plane.

## Pinned upstreams

The branch pins three source trees as Git submodules:

- `upstream/hermes-agent` — desktop shell / interaction architecture.
- `upstream/codex` — open-source Codex CLI and `app-server` integration source.
- `upstream/deepseek-harness` — DeepSeek Harness engine/plugin/UI reference and future adapter source.

Exact SHAs live in `scripts/config.mjs`; the preparation script refuses to continue when a checked-out submodule does not match its pin.

## Current migration stage

Phase A is intentionally conservative:

1. Initialize and verify the pinned upstream repositories.
2. Apply a small, deterministic Zero3 branding overlay to Hermes Desktop.
3. Use an isolated Hermes home under the Zero3 data area instead of mutating the user's normal Hermes profile.
4. Install the Zero3 Pilot skill into that isolated Hermes profile.
5. Start/reuse `zero3-pilot-node` on loopback before launching the desktop in development mode.
6. Let Zero3-specific jobs, automation, memory, browser control, computer control, and Agent dispatch continue through the Zero3 Node policy boundary.

Hermes still owns the chat transport in this first compatibility stage. That is temporary. The next stage replaces the compatibility bridge with a direct Zero3 desktop transport while retaining the Hermes-derived Electron/React shell structure.

## Commands

From this directory:

```powershell
npm run prepare
npm run dev
npm run typecheck
npm run dist:win
```

`npm run prepare` initializes all upstream submodules, verifies their fixed SHAs, applies the Zero3 product-name overlay, writes a build provenance stamp into the Hermes Desktop public assets, and copies `.agents/skills/zero3-pilot/SKILL.md` into the isolated Hermes profile.

`npm run dev` additionally builds/starts the local Zero3 Node when needed and then runs the pinned Hermes Desktop development process with:

- `HERMES_HOME` redirected to Zero3's isolated Hermes data directory.
- `HERMES_DESKTOP_HERMES_ROOT` pinned to `upstream/hermes-agent`.
- `ZERO3_PILOT_NODE_PORT` forwarded to the desktop/skill environment.

`npm run reset` explicitly resets the Hermes submodule back to the pinned SHA and removes the generated provenance asset. It is destructive to tracked changes inside the Hermes submodule, so use it only when you want to discard the local overlay or experiments there.

## Safety rule for upstream modifications

Do not edit the pinned upstream submodules casually. `prepare-upstream.mjs` allows tracked changes only in the two files owned by the current branding overlay:

- `apps/desktop/package.json`
- `apps/desktop/index.html`

Any other tracked change causes preparation to fail instead of silently overwriting developer work.

## Why this is separate from `apps/desktop`

`apps/desktop` is the previous Rust desktop-launcher path. It remains temporarily for comparison and installer compatibility while the v3 shell proves itself. It is not the target architecture and should not receive new UI features.
