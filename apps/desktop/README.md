# Zero3 Pilot Desktop

`zero3-pilot` is now a Windows-first **launcher/sidecar bootstrapper**, not a custom desktop shell.

The visible desktop shell is the installed **Codex Desktop** app. Zero3 keeps its own local runtime (`zero3-pilot-node.exe`) on loopback and exposes Zero3-specific capabilities to Codex through workspace skills/plugins and the local Node API.

## Startup flow

1. Reuse a healthy Zero3 Pilot Node on `127.0.0.1:8790`, or start the sibling `zero3-pilot-node.exe`.
2. Verify that the native Codex Desktop app is installed on Windows.
3. Open the selected workspace using the native `codex://threads/new?path=...` deep link.
4. Leave the Zero3 Node running as a background sidecar so jobs, schedules, browser sessions, memory, and agent dispatch can continue independently of the Codex window.

This deliberately removes Tao/Wry/WebView2 from the product-shell path. Those dependencies remain in the manifest temporarily so the existing workspace lockfile does not churn in this migration branch; they can be deleted together with the next dependency-lock refresh.

## Environment

- `ZERO3_PILOT_NODE_PORT` — local Node port, default `8790`.
- `ZERO3_PILOT_NODE_BIN` — explicit path to `zero3-pilot-node.exe`.
- `ZERO3_CODEX_WORKSPACE` — directory Codex Desktop should open. Defaults to the launcher's current working directory.

## Integration boundary

The Codex Desktop renderer is not copied or forked here. Zero3 integrates at supported/stable seams instead:

- Codex native desktop shell for conversation, projects, diffs, terminal, permissions, and agent UX.
- Workspace skills/plugins for Zero3 commands and tool discovery.
- Zero3 Pilot Node for persistent jobs, schedules, memory, browser/CDP, computer use, and external Agent adapters.
- Codex/app-server integration can be added behind the same sidecar boundary without returning to a custom WebView shell.

The previous Zero3 web dashboard remains available from the Node for diagnostics, but it is no longer the primary desktop shell.
