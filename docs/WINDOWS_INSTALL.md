# Windows installation

> **Pre-release documentation.** Zero3 Pilot has not published a GitHub Release yet. The Windows distribution described here is the `v0.1.0-alpha` candidate path and must not be treated as shipped until the release-readiness gates in Issue #50 are complete.

## Current target package

The Codex-native Windows target is a Zero3-branded **Electron + React** desktop application packaged with NSIS.

The first-alpha packaging design is intentionally self-contained around the reviewed Codex core:

- Zero3 builds the repository's exact pinned open-source Codex revision for Windows;
- the package carries that binary at `resources/zero3-codex/codex.exe`;
- packaged mode uses the bundled reviewed binary rather than PATH, `@latest`, runtime download or an arbitrary host override;
- the package carries the relevant Zero3/OpenAI Codex/Hermes license and NOTICE material under application resources;
- CI verifies the **packaged** Codex binary with `--version` and a real `codex app-server` JSONL smoke before the artifact is accepted.

This replaces the legacy Tao/Wry + `zero3-node` + Inno Setup distribution described by older development documents. Those paths are not the current desktop release architecture.

## Public alpha install

When `v0.1.0-alpha` is actually published, use the Windows installer attached to that GitHub pre-release and verify its SHA-256 against the checksum recorded in the final release notes.

The exact installer filename/checksum are intentionally omitted from this pre-release document until a combined release candidate containing both session-persistence (#49) and bundled-runtime (#51) fixes has passed the final artifact gate.

The installer is intended to be per-user and not require users to separately install Codex just to provide Zero3's native Agent Kernel.

### Signing / SmartScreen

The current alpha CI disables automatic code-signing identity discovery. Unless the final release evidence explicitly records a Windows signing step, expect the first alpha installer to be **unsigned** and Windows may show SmartScreen or an unknown-publisher warning.

An unsigned status is a distribution limitation, not permission to ignore integrity checks: verify the installer SHA-256 against the final release record before running it.

## First launch

Zero3's migrated primary conversation path runs through the bundled pinned Codex app-server.

During migration, some UI surfaces derived from Hermes may still initialize a local Hermes-derived compatibility backend. That compatibility backend exists to support unported UI behavior; it is **not** the authoritative native Agent Kernel and migrated core behavior must not silently fall back to it.

Development sessions created before explicit Zero3 AppServer source tagging are not guaranteed to appear in the first public alpha. Older development builds may have persisted those Threads using Codex's `vscode` session source. Automatically importing every `vscode` row would risk mixing unrelated VS Code Codex history into Zero3, so the alpha does not claim automatic migration of that pre-release state.

## Build the Windows candidate from source

### Prerequisites

Use a Windows development environment with:

- Git;
- Node.js 24;
- a stable Rust MSVC toolchain and the native build prerequisites required by the pinned Codex source;
- sufficient disk space for a full pinned-Codex release build plus Electron packaging.

Clone the reviewed upstream pins:

```powershell
git clone --recurse-submodules https://github.com/Taa965/zero3-pilot.git
cd zero3-pilot
```

Build the target package:

```powershell
cd apps/zero3-desktop
npm run dist:win
```

The release workflow uses this Zero3-owned command path rather than an independent legacy installer script. It prepares the reviewed Hermes-derived shell, applies the managed Codex overlay, builds the pinned Codex CLI in release mode, stages the bundled runtime and legal notices, and invokes the desktop package build with publishing disabled.

Expected build outputs are under:

```text
upstream/hermes-agent/apps/desktop/release/
```

The NSIS artifact uses the Zero3 product naming pattern:

```text
Zero3Pilot-*.exe
```

The unpacked package used by CI must contain at least:

```text
win-unpacked/
  Zero3Pilot.exe
  resources/
    app.asar
    zero3-codex/
      codex.exe
    legal/
      LICENSE-Zero3-Pilot.txt
      NOTICE-Zero3-Pilot.txt
      LICENSE-OpenAI-Codex.txt
      NOTICE-OpenAI-Codex.txt
      LICENSE-Hermes-Agent.txt
```

The exact final artifact layout remains evidence-gated by the Windows Alpha Artifact workflow; this document should be updated if the verified package differs.

## Development mode

For contributors working from source:

```powershell
cd apps/zero3-desktop
npm run prepare
npm run typecheck
npm run dev
```

Development mode may resolve/build the pinned Codex binary from the repository and pass its exact path explicitly to the desktop process. That development override is not the packaged-release trust model.

## Troubleshooting principles

For the public alpha:

- do not fix a packaged-runtime problem by downloading an arbitrary `codex.exe` and replacing the bundled core;
- do not switch the packaged app to `@latest` or an unreviewed PATH binary;
- preserve the exact installer and checksum when reporting packaging/runtime bugs;
- include the Zero3 version, exact release SHA, Windows version and whether SmartScreen/unknown-publisher UI appeared;
- report security-boundary concerns privately according to [`../SECURITY.md`](../SECURITY.md).

## Historical note

Older repository revisions shipped or documented a Tao/Wry shell, a local `zero3-node` authority and an Inno Setup package. That architecture is retained only in history/legacy code while migration completes. It is not the install path documented for the Codex-native first public alpha.
