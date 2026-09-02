# Zero3 Codex session persistence root cause

Pinned Codex `thread/list` defaults to interactive session sources when `sourceKinds` is omitted. Zero3 Desktop creates its primary conversations through `codex app-server`, whose source is exposed as `ThreadSourceKind::AppServer` (`CoreSessionSource::Mcp`). Therefore the previous Zero3 list request omitted the very source that owns Zero3 conversations.

Observable consequences:

- a durable, already-materialized AppServer Thread can remain on disk while disappearing from the sidebar after app/renderer restart;
- because the primary-chat list refresh is authoritative, a refresh that returns no AppServer rows can collapse the visible list to only the currently selected optimistic row, making an older conversation appear to vanish after creating another one.

Fix:

- the Zero3-owned `thread/list` transport always requests `sourceKinds: ['appServer']`;
- legacy Hermes session-list refresh remains blocked from overwriting Codex recents;
- a real pinned-Codex smoke creates two non-ephemeral AppServer Threads, deliberately materializes them using Codex's documented `thread/section/move` persistence path, restarts app-server with the same `CODEX_HOME`, lists `sourceKinds: ['appServer']`, and requires both original Thread IDs plus `thread/read` to succeed.

## Why the smoke explicitly materializes the Threads

Pinned Codex does not promise that an otherwise-empty `thread/start` has a cold-store rollout immediately. Its native contract materializes a fresh non-ephemeral Thread on the first Turn; the section-move path also explicitly materializes a newly started Thread before its first Turn.

The persistence smoke is intentionally credential-free and is testing the **cold-store AppServer source filter**, not model/auth behavior. It therefore uses `thread/section/move` with `sectionId: null`: Codex materializes the rollout while the Thread remains unsectioned. Killing app-server before this step would test persistence of an empty in-memory draft Thread, which is not the contract Zero3 needs to guarantee for existing conversations.
