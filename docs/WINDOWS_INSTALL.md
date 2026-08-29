# Windows installation

Zero3 Pilot ships three Windows binaries as one per-user Inno Setup package:

- `zero3-pilot.exe` — native Tao/Wry/WebView2 desktop shell.
- `zero3-pilot-node.exe` — local-first runtime authority on `127.0.0.1:8790`.
- `zero3-pilot-weixin.exe` — optional Weixin ClawBot channel connector.

## One-click installer

Tagged releases publish `Zero3Pilot-Setup.exe`. PR CI and the Windows Release workflow both build the same installer from `installer/Zero3Pilot.iss`.

The installer uses a per-user destination by default:

```text
%LOCALAPPDATA%\Programs\Zero3 Pilot
```

No administrator elevation is required for the normal install path.

During setup a runtime-check page reports whether the following are detected:

- Microsoft Edge WebView2 / Edge runtime (desktop UI)
- Chrome or Edge (browser/CDP provider)
- Codex CLI
- Claude CLI
- Hermes CLI
- Open Computer Use

The Agent CLIs and Open Computer Use are optional at installation time: install only the backends you intend to use. Missing optional dependencies do not prevent the desktop/runtime from installing.

The setup creates Start Menu entries for Zero3 Pilot and the Weixin ClawBot login/status commands. A desktop shortcut is optional.

## Build the installer from source

On Windows with Rust and Inno Setup 6:

```powershell
git clone --recurse-submodules https://github.com/Taa965/zero3-pilot.git
cd zero3-pilot
cargo build --release -p zero3-node -p zero3-weixin -p zero3-desktop
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' installer\Zero3Pilot.iss
```

The installer is written to:

```text
dist\Zero3Pilot-Setup.exe
```

## Runtime data

By default the local Node and Weixin connector share:

```text
%LOCALAPPDATA%\Zero3Pilot
```

This contains the append-only event log, scheduler SQLite database, memory SQLite database, and (when enabled) the Weixin ClawBot credential state. Set `ZERO3_PILOT_DATA_DIR` before launch to move all local runtime state elsewhere.

## Optional backend overrides

If a CLI is not on PATH, point Zero3 Pilot at it explicitly:

```powershell
$env:ZERO3_CODEX_BIN='D:\Tools\codex.exe'
$env:ZERO3_CLAUDE_BIN='D:\Tools\claude.exe'
$env:ZERO3_HERMES_BIN='D:\Tools\hermes.exe'
$env:ZERO3_OCU_BIN='D:\Tools\open-computer-use.cmd'
```

The desktop starts/reuses the sibling local Node automatically. The Weixin connector is a separate channel process so connecting/disconnecting WeChat never changes the core runtime or desktop lifecycle.
