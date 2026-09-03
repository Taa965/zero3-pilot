# P01 — Planning / Requirement Compiler

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `5b6a062f84e79037ac2e48da79e235c423bf36ac`

Implementation head: `f4c07d9e378cf7e9fe3e28b8e4bf3bc622cf4141`

## Delivered

- structured Planning request/controller-proposal boundary;
- Requirement normalization with deterministic IDs and source anchors;
- stable SHA-256 plan hash;
- deterministic bounded Requirement partitioning with path/tag/dependency affinity;
- Session dependency derivation and topological Wave planning;
- protected/shared/red-zone ownership proposals;
- compiler that converts controller output into C1 Group/Session/Requirement/Wave records;
- all proposals pass the frozen C1 validator before becoming a normalized plan;
- 20-feature fixture requiring 20 Requirements, bounded Session count, and multiple Waves.

## Architecture

Planner output is a proposal, not authority. No model text is persisted as a valid plan until deterministic parsing/normalization and C1 validation succeed. No Agent Loop, Executor implementation, Store, Workspace runtime, Scheduler, or UI was added.

## Static evidence

Changed paths are confined to `apps/zero3-desktop/group-runtime/planning/**` plus this handoff/manifest. No C1 contract file or red-zone Executor/Handoff/Router file was modified.

## Test status

- static review: completed;
- `planning.test.ts`: authored, `NOT_RUN`;
- Windows acceptance: `NOT_RUN`.

## Risks / M1 wiring

- P01 emits worktree/branch identities; P03 owns their real Git creation/verification.
- P01 emits ownership proposals; P03 remains final Git-aware Delivery authority.
- Controller LLM invocation itself is a P06 concern; P01 deliberately accepts structured proposals and provides deterministic fallback behavior.
