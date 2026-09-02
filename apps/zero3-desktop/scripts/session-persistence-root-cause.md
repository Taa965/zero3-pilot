# Zero3 Codex session persistence root cause

Pinned Codex `thread/list` defaults to interactive session sources when `sourceKinds` is omitted. Zero3 Desktop creates its primary conversations through `codex app-server`, whose source is exposed as `ThreadSourceKind::AppServer` (`CoreSessionSource::Mcp`). Therefore the previous Zero3 list request omitted the very source that owns Zero3 conversations.

Observable consequences:

- a durable, already-materialized AppServer Thread can remain on disk while disappearing from the sidebar after app/renderer restart;
- because the primary-chat list refresh is authoritative, a refresh that returns no AppServer rows can collapse the visible list to only the currently selected optimistic row, making an older conversation appear to vanish after creating another one.

Fix:

- the Zero3-owned `thread/list` transport always requests `sourceKinds: ['appServer']`;
- legacy Hermes session-list refresh remains blocked from overwriting Codex recents;
- a real pinned-Codex smoke creates two non-ephemeral AppServer Threads, starts a first Turn on each through the same typed app-server request shape used by Zero3, restarts app-server with the same `CODEX_HOME`, lists `sourceKinds: ['appServer']`, and requires both original Thread IDs plus `thread/read` to succeed.

## Why the smoke starts a first Turn

Pinned Codex does not promise that an otherwise-empty `thread/start` has a cold-store rollout immediately. Its native durable-history contract materializes a fresh non-ephemeral Thread on the first Turn. That is also the real Zero3 conversation path: a conversation becomes user-relevant when a Turn is submitted.

The repository's existing pinned-Codex protocol smoke already proves that credential-free CI can send `turn/start`: a schema-valid request may return a Turn immediately or may later fail because CI intentionally has no model/auth access. The persistence smoke therefore treats invalid-parameter/schema failures as fatal, but permits non-schema runtime failure after the request crosses protocol deserialization. It then requires `thread/list` and `thread/read` to prove that the first-Turn Thread was materialized and remains discoverable.

This deliberately avoids using `thread/section/move` as a persistence shortcut. Section metadata may be durable without being equivalent to the first-Turn rollout/source record that `sourceKinds: ['appServer']` is supposed to filter. The regression test now validates the exact user-facing contract Zero3 needs: **started AppServer conversations survive an app-server restart and remain listed as AppServer threads.**
