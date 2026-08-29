# Zero3 Pilot

**A local-first personal computer agent platform built around the open-source Codex runtime.**

Zero3 Pilot combines:

- **Codex execution maturity** — upstream `openai/codex` stays pinned and unmodified under `upstream/codex`.
- **DeepSeek Harness extensibility ideas** — provider seams, append-only events, background jobs and subagent dispatch are re-expressed as Zero3-owned Rust abstractions rather than embedding another agent runtime.
- **Real computer/browser providers** — Open Computer Use (MCP/UIA) and Chromium CDP through swappable provider contracts.
- **Codex / Claude / Hermes workers** — bounded real CLI adapters behind one Subagent Registry.
- **Persistent scheduler and scoped memory** — SQLite-backed automation and operational/personal memory with approval boundaries.
- **Windows desktop** — native Tao + Wry/WebView2 shell over the loopback-only Pilot Node.
- **Weixin ClawBot channel** — direct Tencent iLink HTTP/JSON integration; authenticated owner commands enter Zero3 through explicit `/pilot` messages without embedding OpenClaw.

It is not a Codex fork with extra tools and it is not a stack of nested Harness runtimes. Codex, computer use, browser automation, messaging channels and external agents remain replaceable dependencies behind Zero3-owned contracts.

## Current status

The current MVP product baseline is implemented and CI-validated on Linux and Windows:

- durable EventStore + JobManager recovery
- BrowserProvider with real Chromium smoke
- Open Computer Use with real Windows Notepad/UIA smoke
- real Codex / Claude / Hermes workers
- persistent Scheduler and Memory
- loopback Pilot Node and local control UI
- native Windows WebView2 desktop
- strict test -> release build -> atomic exact-SHA deployment for the cloud health surface
- Windows one-click installer and dependency-check wizard
- optional Weixin ClawBot command channel

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for runtime boundaries.

## Windows install

Tagged releases publish `Zero3Pilot-Setup.exe`. The installer is per-user by default and checks WebView2/Edge, Chrome/Edge, Codex, Claude, Hermes and Open Computer Use before installation.

See [`docs/WINDOWS_INSTALL.md`](docs/WINDOWS_INSTALL.md).

Build the installer from source:

```powershell
git clone --recurse-submodules https://github.com/Taa965/zero3-pilot.git
cd zero3-pilot
cargo build --release -p zero3-node -p zero3-weixin -p zero3-desktop
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' installer\Zero3Pilot.iss
```

## Weixin ClawBot

After installation use the Start Menu item **连接微信 ClawBot**, or run:

```powershell
zero3-pilot-weixin.exe login
zero3-pilot-weixin.exe run
```

Only the WeChat account that scanned the QR code is accepted, and only messages beginning with `/pilot` are executed. See [`docs/WEIXIN_CLAWBOT.md`](docs/WEIXIN_CLAWBOT.md).

## Development

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --all-targets
cargo test --workspace
```

## Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Notices

- Zero3 Pilot is an independent, unofficial project. It is **not** an OpenAI product.
- **Codex** is a project/trademark of OpenAI.
- **DeepSeek Harness** architecture ideas are credited; none of its code is vendored here.
- Weixin ClawBot transport follows Tencent's public `openclaw-weixin` iLink protocol. Zero3 Pilot does not vendor or embed the OpenClaw runtime.
- Every third-party dependency is governed by its own license; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) and `CONTRIBUTING.md` before importing code from another project.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
