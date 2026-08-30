# Zero3 Pilot Remote Host H4 — Durable Outbox

## Purpose

H4 makes control-plane mirroring crash-safe without moving execution authority out of Codex.

The local host must never lose a terminal outcome or manufacture a new Codex execution merely because the control plane is temporarily unreachable.

## Authority

1. Codex Thread / Turn / Item state remains authoritative for development execution.
2. The H4 outbox is delivery state only.
3. The control plane remains authoritative for leases, fencing and accepted remote mirrors.
4. An outbox replay never starts, resumes or steers a Codex Turn.

## Scope

H4 adds:

- durable local event envelopes before network publication;
- durable terminal envelopes before network publication;
- stable per-task event sequence allocation across process restarts;
- replay after reconnect/restart;
- acknowledgement-based deletion only after the control plane accepts the envelope;
- bounded storage and fail-closed behavior when the outbox cannot be persisted;
- original lease and fencing identity preservation on every replayed envelope.

H4 does not add:

- a planner or model loop;
- direct shell/Git execution;
- a generic Codex JSON-RPC bridge;
- local authority to override control-plane lease/fencing decisions.

## Delivery invariant

For every envelope that matters to remote correctness:

```text
create local envelope
  -> durable local persistence
  -> ordered outbox drain
  -> network attempt
  -> control-plane acceptance
  -> local acknowledgement/removal
```

Network publication must not happen before durable persistence.

No newly created event or terminal envelope may bypass an older committed pending envelope. After persistence, all publication goes through the same ordered outbox drain. A transient failure on an older envelope therefore prevents later evidence or terminal state from overtaking it.

## Event identity

An event identity is bound to:

```text
task_id + execution_id + lease_id + fencing_token + event_sequence
```

`event_sequence` is allocated durably per task/execution and never resets merely because Electron restarts.

## Terminal invariant

A terminal result is written to the local outbox before the first `/complete`, `/fail`, or `/blocked` request. If publication fails, the terminal envelope remains replayable after reconnect.

A terminal envelope never causes Codex execution to rerun and never bypasses older pending evidence from the outbox.

## Replay

On Remote Host startup and after control-plane reconnection:

1. load durable pending envelopes;
2. preserve the original lease/fencing identity;
3. replay oldest-first using the same ordered drain used by newly created envelopes;
4. stop at the first transient publication failure so later envelopes cannot overtake it;
5. delete only envelopes explicitly accepted by the control plane;
6. stop or quarantine an envelope when the control plane reports it stale/invalid rather than mutating its fencing identity.

## Storage

H4 storage is host-owned under the same local Remote Host state root as task mappings. It must not contain bearer credentials.

The implementation uses independently persisted envelope files so a partial write cannot corrupt the entire queue. Temporary files are never treated as committed envelopes.
