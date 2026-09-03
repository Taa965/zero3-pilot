# P05 — Session Scheduler

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `5b6a062f84e79037ac2e48da79e235c423bf36ac`

Implementation head: `370325884fe478e8df350f01eb7bf0d7cd6a2705`

## Delivered

- deterministic Scheduler DAG/wave validation;
- same-Wave implementation dependency rejection;
- dependency readiness evaluation;
- Wave Gate requiring prior integration + Delivery + ownership evidence;
- bounded `maxParallelSessions` slots;
- group/session pause/resume/cancel controls;
- explicit retry requests only for Failed/Blocked sessions;
- attempt budget and Repair Wave budget enforcement;
- `OutcomeUnknown` permanently excluded from automatic retry;
- deterministic ordering with ready-since sequence to reduce starvation.

## Architecture

Scheduler chooses Development Sessions only. It does not create/manage Codex Subagents, execute provider APIs, merge branches, approve permissions, or infer verification success.

## Static evidence

Changed paths are confined to `apps/zero3-desktop/group-runtime/scheduler/**` plus this handoff/manifest.

## Test status

- static review: completed;
- `scheduler.test.ts`: authored, `NOT_RUN`;
- concurrency/process behavior: `NOT_RUN`.

## Risks / M1 wiring

- P07 provides Integration Milestone evidence consumed by Wave Gate.
- P08 uses the same group Repair budget; M2 wiring must ensure a single durable counter authority rather than two counters.
