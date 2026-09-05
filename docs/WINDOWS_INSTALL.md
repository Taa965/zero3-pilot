# Windows installation

The `v0.1.0-alpha` Windows target is a Zero3-branded **Electron + React** desktop application packaged with NSIS and distributed through the matching GitHub pre-release.

## Package trust model

The first-alpha package is intentionally self-contained around the reviewed Codex core:

- Zero3 builds the repository's exact pinned open-source Codex revision for Windows;
- the package carries that binary at `resources/zero3-codex/codex.exe`;
- packaged mode uses the bundled reviewed binary rather than PATH, `@latest`, runtime download or an arbitrary host override;
- the package carries the relevant Zero3/OpenAI Codex/Hermes license and NOTICE material under application resources;
- CI verifies the **packaged** Codex binary with `--version` and a real `codex app-server` JSONL smoke before an artifact candidate is accepted.

This replaces the legacy Tao/Wry + `zero3-node` + Inno Setup distribution described by older development documents. Those paths are not the current desktop release architecture.

## Release validation baseline

A full independent Windows acceptance run on pre-#54 candidate `961c04c66431a5e92e56e6887722ba9ed859f566` passed the bundled Codex/runtime, real app-server, #49 cold-restart persistence, feature-gate and NSIS checks.

After the final release-hygiene repair, PR #54 passed every triggered repository workflow, including the Windows Alpha Artifact gate. Its downloaded pre-tag artifact contained:

```text
Zero3Pilot-0.1.0-alpha-win-x64.exe
size: 185,183,120 bytes
pre-tag validation SHA-256:
3EAD2DED013EFCFC2F3BC80945352AB7061B75B907818434FE5ED22BA3C5EDB6
```

The release owner explicitly waived an additional local Windows exact-main rerun after #54. That status is **`WAIVED_BY_RELEASE_OWNER`**, not PASS.

The distributed installer must therefore come from the **tag-triggered Windows Alpha Artifact** workflow. Use the SHA-256 recorded on the GitHub Release for the actual public installer; do not substitute the pre-tag validation checksum above for the release checksum.

## Install `v0.1.0-alpha`

1. Open the `v0.1.0-alpha` GitHub pre-release.
2. Download `Zero3Pilot-0.1.0-alpha-win-x64.exe` from that release.
3. Verify its SHA-256 against the checksum recorded in the GitHub Release notes.
4. Run the installer.

The installer is intended to be per-user and does not require users to separately install an arbitrary Codex binary just to provide Zero3's native Agent Kernel.

### Signing / SmartScreen

`v0.1.0-alpha` is distributed **unsigned**. Windows may therefore show SmartScreen or an unknown-publisher warning.

Unsigned status is a distribution limitation, not permission to ignore integrity checks. Verify the installer SHA-256 from the GitHub Release before running it.

## First launch

Zero3's migrated primary conversation path runs through the bundled pinned Codex app-server.

During migration, some UI surfaces derived from Hermes may still initialize a local Hermes-derived compatibility backend. That compatibility backend exists to support unported UI behavior; it is **not** the authoritative native Agent Kernel and migrated core behavior must not silently fall back to it.

Development sessions created before explicit Zero3 AppServer source tagging are not guaranteed to appear in the first public alpha. Older development builds may have persisted those Threads using Codex's `vscode` session source. Automatically importing every `vscode` row would risk mixing unrelated VS Code Codex history into Zero3, so the alpha does not claim automatic migration of that pre-release state.

## Build from source

### Prerequisites

Use a Windows development environment with:

- Git;
- a Node.js/npm combination allowed by the pinned desktop upstream;
- the Rust toolchain declared by the pinned Codex repository plus required MSVC native build prerequisites;
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

## Development mode

For contributors working from source:

```powershell
cd apps/zero3-desktop
npm run prepare
npm run codex:verify
npm run typecheck
npm run dev
```

Development mode may resolve/build the pinned Codex binary from the repository and pass its exact path explicitly to the desktop process. That development override is not the packaged-release trust model.

## Troubleshooting principles

- do not fix a packaged-runtime problem by downloading an arbitrary `codex.exe` and replacing the bundled core;
- do not switch the packaged app to `@latest` or an unreviewed PATH binary;
- preserve the exact installer and checksum when reporting packaging/runtime bugs;
- include the Zero3 version, exact release SHA, Windows version and whether SmartScreen/unknown-publisher UI appeared;
- report security-boundary concerns privately according to [`../SECURITY.md`](../SECURITY.md).

## Historical note

Older repository revisions shipped or documented a Tao/Wry shell, a local `zero3-node` authority and an Inno Setup package. That architecture is retained only in history/legacy code while migration completes. It is not the install path documented for the Codex-native first public alpha.
