# P04 — Development Session Runtime / Zero3Executor Binding

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `5b6a062f84e79037ac2e48da79e235c423bf36ac`

Implementation head: `78bb18be32ba819d2eac52a4ba44db15573055b0`

## Delivered

- deterministic Development Session prompt builder from frozen C1 scope;
- narrow `ExecutorManagerPort` matching existing Zero3Executor Manager public operations;
- exact Group/Session/execution/workspace/branch identity binding into `ExecutorTaskIdentity`;
- start / start-from-Handoff / resume / prompt / permission response / cancel / close lifecycle;
- narrow `SessionRuntimeStorePort` instead of coupling to P02 sibling implementation;
- bounded attempt enforcement;
- permission requests remain external decisions and are never auto-approved;
- `context_lost` / `context_exhausted` stop Blocked for Handoff/Resume;
- active-prompt transport/process ambiguity enters `OutcomeUnknown` with no blind retry;
- Session durable event sequence is independent from per-prompt Executor stream sequence.

## Architecture

P04 does not modify `executor-runtime/**`; it consumes the frozen Executor contract only. Native Codex remains the only default Development Session executor and native Codex Subagents remain inside the Session.

## Static evidence

Changed paths are confined to `apps/zero3-desktop/group-runtime/session/**` plus this handoff/manifest.

## Test status

- static review: completed;
- `session-runtime.test.ts`: authored, `NOT_RUN`;
- real Codex Thread/subagent validation: `NOT_RUN`;
- Windows acceptance: `NOT_RUN`.

## Risks / M1 wiring

- P99/P06 must adapt `SessionRuntimeStorePort` to P02 `DevelopmentGroupStore` after M1.
- P05 decides retry eligibility; P04 never retries OutcomeUnknown itself.
