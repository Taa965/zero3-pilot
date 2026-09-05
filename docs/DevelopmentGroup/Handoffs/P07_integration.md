# P07 — Integration Controller

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `382c4ced5f9b765545e71776468de32fa6f4f237` (M1)

Implementation head before handoff record: `a291e3e06529001e00854a09d9f07ecfd71de754`

## Delivered

- deterministic integration queue ordered by Wave and enqueue sequence;
- dependency-aware readiness;
- Delivery Gate revalidation immediately before merge;
- exact worker branch-head check and clean integration-workspace check;
- fixed-argv Git merge adapter with conflict abort;
- optional post-merge guard with exact prior-SHA rollback on failure;
- durable Integration Milestone records; workers never self-merge.

## Closeout repair

Static review found that a reconstructed Integration Controller started with an empty in-memory `integratedSessionIds` set. A queued dependent Delivery could therefore remain blocked after restart even when its dependency had already been durably integrated. P07 now accepts an explicit `initialIntegratedSessionIds` seed so the wiring layer can reconstruct dependency state from durable integration records.

## Architecture

P07 owns integration mechanics only. It does not validate verification success, create repair work, approve permissions, or modify the C1 contract.

## Test status

- static review: `PASS`;
- integration tests including restart dependency seeding: authored/updated, `NOT_RUN`;
- real Git conflict/rollback behavior: `NOT_RUN`;
- Windows integration acceptance: `NOT_RUN`.

## Integration notes

The M2 wiring layer must seed `initialIntegratedSessionIds` from durable merged Integration Milestones rather than from worker claims or volatile process memory.
