# Codex-native Thread Actions — R3D

R3D migrates the first set of session/thread lifecycle actions from Hermes Runtime semantics to the pinned open-source Codex app-server used as Zero3 Pilot's sole Agent Kernel.

Pinned protocol baseline:

- Codex: `94311d447587411789533c47601fd8bc9d81eb48`
- Hermes UI shell: `f7c79efbac19ae18e8dee7c79a4e4c0935299b5f`

## Implemented

The Hermes-derived UI remains presentation only. These existing UI actions now route through typed `window.zero3Codex` methods and purpose-specific Electron IPC:

```text
archive session       -> thread/archive
restore archived      -> thread/unarchive
permanent delete      -> thread/delete
rename                -> thread/name/set
fork whole thread     -> thread/fork
steer active turn     -> turn/steer
```

The archived-sessions settings surface reads `thread/list({ archived: true })` and filters internal child threads and ephemeral threads. Existing destructive-delete confirmation UI is preserved.

Hermes' auto-archive configuration is hidden while the Codex core path is active because that policy belongs to Hermes state and does not control Codex Threads.

## Security boundary

Renderer code does not receive a generic Codex JSON-RPC method. Every action has a dedicated typed IPC route and Electron main reconstructs/validates request parameters.

Whole-thread fork is intentionally narrower than the full Codex protocol. R3D does not expose `lastTurnId` to Renderer code. Electron main forces:

```text
approvalPolicy = on-request
sandbox = read-only
```

This prevents a fork from silently inheriting a more permissive legacy thread configuration.

`turn/steer` reuses the R3C `UserInput` validator and currently permits text only. Unsupported structured steer input fails closed.

No R3D action routes through Zero3 Node, Hermes Runtime `requestGateway`, or a localhost proxy.

## Deliberately deferred

### Message-level fork

Codex `thread/fork.lastTurnId` requires a **Codex Turn ID**. Hermes-rendered message IDs on the migrated presentation surface are commonly Codex Item IDs. R3D therefore supports only whole-thread fork until Zero3 maintains an authoritative Item/Message -> Turn mapping.

### Revert / regenerate / edit history

Pinned Codex exposes `thread/revert` and also retains deprecated `thread/rollback`, but R3D exposes neither to Renderer code yet.

`thread/revert.beforeTurnId` also requires a real Turn ID. More importantly, Codex thread revert changes persisted conversation history; it must not be presented as if it automatically restored or undid files already changed on disk.

Zero3 will add history operations only after the UI can state these semantics accurately and target the correct Turn.

## Acceptance criteria

R3D is acceptable only when all of the following hold:

1. deterministic prepare generates archive/unarchive/delete/name/fork/steer typed IPC on the pinned Hermes shell;
2. fork output is forced to `read-only` + `on-request` and Renderer cannot provide `lastTurnId`;
3. archived settings use Codex Threads and do not expose Hermes auto-archive as a Codex setting;
4. message-level revert/rollback IPC is absent;
5. existing Codex Core Smoke still launches the pinned app-server and completes the real JSONL handshake;
6. Hermes Desktop typecheck and build remain green;
7. no Zero3 Node or Hermes Runtime fallback is introduced for these actions.
