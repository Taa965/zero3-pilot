# Zero3 Codex session persistence root cause

Pinned Codex `thread/list` defaults to interactive session sources when `sourceKinds` is omitted. Zero3 Desktop creates its primary conversations through `codex app-server`, whose source is exposed as `ThreadSourceKind::AppServer` (`CoreSessionSource::Mcp`). Therefore the previous Zero3 list request omitted the very source that owns Zero3 conversations.

Observable consequences:

- a durable Thread can remain on disk while disappearing from the sidebar after app/renderer restart;
- because the primary-chat list refresh is authoritative, a refresh that returns no AppServer rows can collapse the visible list to only the currently selected optimistic row, making an older conversation appear to vanish after creating another one.

Fix:

- the Zero3-owned `thread/list` transport always requests `sourceKinds: ['appServer']`;
- legacy Hermes session-list refresh remains blocked from overwriting Codex recents;
- a real pinned-Codex smoke creates two non-ephemeral AppServer threads, restarts app-server with the same `CODEX_HOME`, lists `sourceKinds: ['appServer']`, and requires both original thread ids plus `thread/read` to succeed.
