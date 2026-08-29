# Zero3 Codex Primary Chat — R2A

R2A moves the **main desktop chat path** from Hermes Runtime semantics onto the pinned open-source Codex app-server while preserving the mature Hermes-derived Electron/React UI shell.

## Runtime path

```text
Hermes-derived ChatView / Composer UI
        |
Zero3 Codex primary-chat adapter
        |
window.zero3Codex (typed preload API)
        |
Electron main JSONL client
        |
codex app-server --stdio
        |
pinned upstream/codex
```

Zero3 Node is not part of this path. Hermes Gateway may still boot temporarily because the upstream shell has other compatibility dependencies, but it no longer owns the primary chat callbacks when the `zero3Codex` preload surface is present.

## R2A mapping

- New main chat -> `thread/start`
- Session list -> `thread/list`
- Resume/history -> `thread/resume` + `thread/read(includeTurns=true)`
- Send text -> `turn/start`
- Assistant streaming -> `item/started`, `item/agentMessage/delta`, `item/completed`
- Turn settlement -> `turn/completed`
- Stop / Esc -> `turn/interrupt`
- Thread title/status -> Codex thread notifications

Codex Thread/Turn/Item state is projected into the existing Hermes `SessionInfo` / `ChatMessage` presentation stores. Those types are now presentation adapters on this path, not runtime authority.

## Safety boundary in R2A

Approval/tool UI is not mapped yet. Therefore primary Codex threads are deliberately started with:

```text
approvalPolicy = never
sandbox = read-only
```

This prevents R2A from hanging on an approval request and prevents the primary chat from modifying the workspace before the native approval surface exists. Any unexpected server-originated request is answered fail-closed rather than auto-approved.

R3 must replace this temporary read-only policy with native approval/input routing before workspace-write execution is enabled.

## Deliberate limitations

R2A is a primary-chat cut, not full feature parity. The following are deliberately not sent back through Hermes Runtime and currently fail closed or remain compatibility-only:

- attachments in the primary Codex chat;
- edit / rewind / regenerate / branch;
- archive/delete through Codex native thread APIs;
- mid-turn steering;
- rich rendering for command execution, file changes, reasoning, MCP/dynamic tools and collaboration items;
- native approval / user-input prompts;
- multi-pane/session-tile Codex parity.

These move next through R2B/R3. The compatibility backend must not be used as a fallback core for these missing operations.

## Protocol regression evidence

The dedicated Codex Core Smoke compiles the exact pinned `upstream/codex`, launches `codex app-server --stdio`, then validates:

```text
initialize -> initialized -> thread/list -> thread/start -> turn/start
```

The turn payload uses the pinned protocol's exact `UserInput` field `text_elements`. Runtime authentication/model failures are allowed in credential-free CI only after protocol deserialization succeeds; invalid-params / unknown-field failures are release blockers.
