# R3F — Codex Authoritative History

R3F continues the Hermes-to-Codex migration without introducing a second runtime.

## Runtime authority

Zero3 Pilot continues to use the pinned open-source Codex app-server as the only Agent Kernel. Hermes remains the Electron/React shell. This phase does not call Hermes history/rewind RPCs and does not expose a generic Codex JSON-RPC bridge to the renderer.

Pinned protocol target: `openai/codex@94311d447587411789533c47601fd8bc9d81eb48`.

## Native history pagination

The pinned Codex protocol exposes `thread/turns/list` with cursor pagination and a `TurnItemsView` selector. R3F adds one narrow typed renderer action for this method.

The Electron main process owns the policy and forces:

- `limit = 100`
- `sortDirection = asc`
- `itemsView = full`

The renderer may provide only `threadId` and the opaque `cursor`. It cannot change the sort order, page size, item detail level, method name, or executable path.

R3F rehydrates an authoritative thread by:

1. `thread/read({ threadId, includeTurns: false })` for thread metadata.
2. Repeated `thread/turns/list` pages in ascending order with `itemsView=full`.
3. Rejecting missing `Turn.id`, non-full item views, duplicate Turn ids, repeated cursors, and pagination beyond the bounded 512-page safety ceiling.
4. Combining the native metadata and native full Turn list only after pagination completes.

This replaces R3E's `thread/read(includeTurns=true)` snapshot for message-boundary resolution and post-fork/post-revert rehydration.

`thread/items/list` was also audited at the pinned Codex revision. It returns `{ turnId, item }` entries and is useful for targeted item browsing, but R3F does not expose it because `thread/turns/list(itemsView=full)` already supplies the complete ThreadItems needed by the current main-chat history actions. Avoiding an unused renderer capability keeps the boundary narrower.

## Historical user edit

Hermes models edit as a destructive rewind plus resubmit. R3F maps the visible edit action to Codex only when the mapping is exact:

`AppendMessage.sourceId/parentId → ChatMessage.id → ThreadItem.id → Turn.id → thread/revert(beforeTurnId) → authoritative rehydrate → turn/start(new text)`.

The action fails closed when:

- the clicked source cannot be resolved to one authoritative Codex user item;
- the Turn is still in progress;
- the Turn does not contain exactly one visible user message;
- the original Turn includes image input;
- the edited payload contains non-text content;
- the active/selected thread changed before the destructive mutation.

R3F does not use row ids, visible-user ordinals, timestamps, text matching, or array positions to choose the destructive boundary.

## Disk safety

`thread/revert` changes persisted conversation history only. It is not Git reset, worktree rollback, patch undo, or filesystem rollback. R3F does not present it as one.

## Remaining work after R3F

The next migration slices should continue auditing queue/slash-command behavior, attachments that require lossless structured-input replay, reasoning/tool-history presentation, and UI-visible history pagination. Unsupported Hermes semantics should remain explicitly unavailable until the pinned Codex protocol can represent them exactly.
