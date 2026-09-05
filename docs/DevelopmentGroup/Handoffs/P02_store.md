# P02 — Durable Group Store / Event Ledger

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `5b6a062f84e79037ac2e48da79e235c423bf36ac`

Implementation head: `8d115b5e0608b6748358b5559665c72d34fd6da6`

## Delivered

- checksum-wrapped durable JSON records;
- temp write -> file fsync -> atomic rename persistence;
- interrupted temp recovery with ambiguity fail-closed;
- append-only checksummed `events.jsonl` ledger;
- contiguous monotonic event sequence and duplicate-event idempotency;
- durable Group directory layout for definition/state/requirements/sessions/deliveries/integration/verification/repair;
- restart reconcile that detects ledger-ahead semantic replay without inventing state;
- path-segment hardening for durable IDs.

## Architecture

No new database/native dependency was introduced. P02 is storage only: it does not decide planning, scheduling, completion, merge, permission, or executor behavior.

## Static evidence

Changed paths are confined to `apps/zero3-desktop/group-runtime/store/**` plus this handoff/manifest. C1 and existing Executor/Handoff/Router code are untouched.

## Test status

- static review: completed;
- `store.test.ts`: authored, `NOT_RUN`;
- Windows restart acceptance: `NOT_RUN`.

## Risks / M1 wiring

- Runtime semantic event replay is intentionally not implemented here; P06 owns state reduction/controller logic.
- Directory fsync is best-effort only on Windows filesystems that reject directory handles; file fsync occurs before rename.
