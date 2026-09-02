# Zero3 Codex session persistence root cause

Two independent pinned-Codex behaviors combined to hide Zero3 conversations after restart:

1. The packaged `codex app-server` wrapper did not expose the standalone app-server's existing `--session-source` startup argument and instead passed `SessionSource::VSCode` unconditionally into `run_main_with_transport_options`.
2. `thread/list` defaults to interactive session sources when `sourceKinds` is omitted.

Zero3 therefore could not claim an explicit AppServer/MCP persistence namespace through the same reviewed `codex.exe` that is shipped with the desktop package. In pinned Codex the transport and persisted source identity are deliberately separate concepts: `SessionSource::from_startup_arg('app-server')` maps to `SessionSource::Mcp`, and `ThreadSourceKind::AppServer` matches `CoreSessionSource::Mcp`. Merely using the AppServer transport does not make a Thread an AppServer-source Thread.

Observable consequences:

- a durable, already-materialized Zero3 Thread could remain on disk but be absent from the source namespace Zero3 expected to rehydrate;
- because the primary-chat list refresh is authoritative, a refresh that returns no Zero3 rows can collapse visible recents to only the currently selected optimistic row, making an older conversation appear to vanish after creating another one;
- a persistence smoke that launches the packaged Codex wrapper in its original hardcoded VS Code source while filtering for `appServer` correctly returns an empty list, so it cannot prove the desired Zero3 contract;
- attempting to add `--session-source app-server` only in the Electron launcher or smoke is insufficient unless the pinned `codex app-server` wrapper itself exposes and forwards that argument.

Fix:

- a reviewed foundation overlay exposes `--session-source` on the pinned `codex app-server` wrapper using the exact parser already present in pinned Codex's standalone app-server; the upstream-compatible default remains `vscode`;
- the production Zero3 launcher explicitly starts the reviewed/patched pinned Codex with `--session-source app-server`;
- the Zero3-owned `thread/list` transport always requests `sourceKinds: ['appServer']`;
- legacy Hermes session-list refresh remains blocked from overwriting Codex recents;
- a real pinned-Codex smoke mirrors the production launcher, creates two non-ephemeral AppServer-source Threads, starts a first Turn on each, restarts app-server with the same `CODEX_HOME`, lists `sourceKinds: ['appServer']`, and requires both original Thread IDs plus `thread/read` to succeed.

## Why the smoke starts a first Turn

Pinned Codex does not promise that an otherwise-empty `thread/start` has a cold-store rollout immediately. Its native durable-history contract materializes a fresh non-ephemeral Thread on the first Turn. That is also the real Zero3 conversation path: a conversation becomes user-relevant when a Turn is submitted.

The repository's existing pinned-Codex protocol smoke proves that credential-free CI can send `turn/start`: a schema-valid request may return a Turn immediately or may later fail because CI intentionally has no model/auth access. The persistence smoke therefore treats invalid-parameter/schema failures as fatal, but permits non-schema runtime failure after the request crosses protocol deserialization. It then requires `thread/list` and `thread/read` to prove that the first-Turn Thread was materialized and remains discoverable.

This deliberately avoids using `thread/section/move` as a persistence shortcut. Section metadata may be durable without being equivalent to the first-Turn rollout/source record that `sourceKinds: ['appServer']` filters. The regression test now validates the exact user-facing contract Zero3 needs: **started Zero3 AppServer-source conversations survive an app-server restart and remain listed in Zero3's AppServer namespace.**
