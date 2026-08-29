# R3E — Codex message / Item / Turn mapping

R3E gives Zero3 a safe message-level history boundary without weakening the Codex-core architecture.

The authoritative chain is:

```text
Hermes ChatMessage.id (presentation)
        ↓ exact id or turn/start alias
Codex ThreadItem.id
        ↓ parent Turn from thread/read(includeTurns=true)
Codex Turn.id
        ↓ typed dedicated IPC
thread/fork(lastTurnId) or thread/revert(beforeTurnId)
```

Zero3 never infers a Turn from message array position, timestamp, text ordinal, or a Hermes Runtime row id.

## Pinned protocol contract

R3E is implemented against the pinned open-source Codex commit:

```text
94311d447587411789533c47601fd8bc9d81eb48
```

At that pin:

- `Thread.turns[]` contains Codex `Turn` records when history is requested.
- every `Turn` has its own `id` and `items: Vec<ThreadItem>`.
- user and assistant `ThreadItem` records have their own `id`.
- item lifecycle notifications also carry `turnId` directly.
- `thread/fork(lastTurnId)` keeps the referenced Turn and drops later Turns from the new fork.
- `thread/revert(beforeTurnId)` removes the referenced Turn and all later Turns from persisted conversation history.
- `thread/revert` **does not revert local file/worktree changes**.

The R3E CI smoke checks these facts against the pinned Rust protocol source so a future Codex pin cannot silently change the meaning of the UI actions.

## New typed desktop boundary

R3E adds two purpose-specific Electron IPC operations:

```text
zero3:codex:thread:fork-at-turn
zero3:codex:thread:revert-before-turn
```

They map only to:

```text
thread/fork
thread/revert
```

There is still no generic Renderer JSON-RPC proxy.

The ordinary R3D whole-thread fork remains `{ threadId }` only. R3E's dedicated message-level fork additionally accepts a required `lastTurnId`, while Electron main still forces:

```text
approvalPolicy = on-request
sandbox = read-only
```

Renderer code cannot relax those values.

## Authoritative resolution

Before a message-level mutation, Zero3 re-reads the thread with `includeTurns=true` and searches the returned `Turn.items` for the selected message id. A live optimistic user bubble is the only exception: its synthetic presentation id is bound to the real `Turn.id` returned by that exact `turn/start` call, then the thread is re-read before a destructive operation.

If the mapping is absent or ambiguous, the action fails closed.

## Message-level branch

Hermes historically branches at an exact chat bubble. Codex forks at a Turn boundary, so these are not always equivalent.

R3E permits a message-level branch only when:

- the selected message is an assistant message;
- its `ThreadItem.id` maps to a completed Codex Turn;
- it is the final visible user/assistant message item in that Turn.

Then Zero3 calls:

```text
thread/fork({ threadId, lastTurnId: mappedTurnId })
```

### User-message branch remains fail-closed

A normal Codex Turn contains the user message and the assistant response. Forking with that Turn's `lastTurnId` would therefore include the assistant response even if the user clicked the earlier user bubble. That is not the same operation as Hermes' exact-bubble branch.

R3E does not pretend they are equivalent. User-bubble branching stays blocked until Zero3 either gains a protocol-level partial-Turn history primitive or deliberately implements that capability inside its Codex fork.

The same rule applies to an assistant bubble that is followed by another visible message inside the same Turn.

## Restore to user message

For a user message, R3E requires that the mapped Turn contain exactly one user message and that the Turn is no longer in progress. It then:

1. calls `thread/revert({ beforeTurnId: mappedTurnId })`;
2. re-reads and rebinds the retained Codex history;
3. submits the authoritative user text as a fresh Turn.

This matches the existing Hermes restore/regenerate model at a Codex Turn boundary without using Hermes Runtime truncation semantics.

Turns containing image input are not replayed in R3E because the current restore callback does not carry the original attachment objects needed for a safe destructive replay. They fail closed instead of silently dropping image context.

## Regenerate

Regenerate resolves the relevant message to its Codex Turn, then requires that Turn to contain exactly one user message. If no explicit message id is supplied, Zero3 selects the latest completed Turn that satisfies that rule.

It uses the same `revert-before-turn -> re-read -> fresh turn/start` sequence as restore.

## Worktree safety

`thread/revert` is conversation-history mutation only. R3E must never label it as Git reset, file rollback, worktree restore, or undo of already-applied tool side effects.

If a user needs file rollback, that must be a separate Codex/Zero3 capability with its own explicit file/Git semantics and confirmation boundary.

## Still deferred

R3E deliberately does not add:

- partial-Turn user-bubble branch;
- replay of image-bearing Turns;
- arbitrary renderer-supplied JSON-RPC methods;
- file/worktree rollback disguised as conversation revert;
- Hermes Runtime or Zero3 Node fallback for these actions.

These restrictions are acceptance criteria, not missing fallback paths.
