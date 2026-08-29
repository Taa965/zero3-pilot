# Zero3 Desktop Phase B2 — Native Chat Transport

## Goal

Establish the first functional chat turn that does **not** use Hermes Gateway as the renderer transport.

The Phase B2A path is:

```text
Zero3 renderer
  -> window.zero3Desktop.chatTurn(...)
  -> Electron preload
  -> zero3:chat:turn IPC
  -> Electron main validation + native approval
  -> fixed Zero3 Node Agent job API
  -> registered Agent backend
  -> Zero3 job result
  -> Electron main
  -> Zero3 renderer
```

The renderer never receives arbitrary localhost/network access. It can only call the dedicated typed `chatTurn` surface.

## Safety boundary

A chat turn currently reuses the existing Zero3 Agent-dispatch policy gate. If the Agent dispatch requires elevated permission, Electron main shows the native one-shot approval dialog before the job is submitted. The renderer cannot set `approved` or `granted_level`.

Conversation history is bounded to the most recent 24 user/assistant messages and each message is bounded to 20,000 characters before it crosses IPC.

## Current UI

`Settings -> Zero3 总控 -> Zero3 原生 Chat` is the Phase B2 transport probe. It provides:

- Agent selection.
- A local transcript retained across desktop reloads via renderer localStorage.
- A typed `chatTurn` call instead of direct Agent-job orchestration in renderer code.
- Native approval when required.
- A complete user message -> Agent result round trip without Hermes Gateway transport.

## Deliberate limitations of B2A

This is not yet the final main-chat replacement. The current turn is non-streaming and waits for the underlying Agent job to reach a terminal state. The transcript is local UI state rather than a Zero3 Node durable conversation record.

The next B2 slices are, in order:

1. Zero3 Node durable chat sessions and messages.
2. Event streaming (`started`, text deltas/tool events, terminal/error).
3. Stop/cancel generation.
4. Approval/input events as first-class chat events instead of a turn-level modal only.
5. A transport adapter for the existing Hermes-derived main chat UI.
6. Remove Hermes Gateway from the default desktop chat boot dependency once parity gates pass.

## Gate

Every change remains behind the existing pinned-upstream and Windows desktop gates. The overlay is fail-closed: if the pinned Hermes Electron/React source or the Zero3 native bridge changes such that a patch anchor no longer matches, desktop preparation fails and requires explicit review.
