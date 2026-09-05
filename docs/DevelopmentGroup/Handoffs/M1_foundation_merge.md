# M1 — Development Group Foundation Merge

Status: **SUCCESS_STATIC**

Integrated code SHA before this milestone record: `d0ba9aaf6e52c786c12b6b42d9f764c6dcf8f865`

The Wave 2 baseline is the `integration/development-group-v1` commit that contains this M1 record.

## Integrated sessions

1. P01 — Planning / Requirement Compiler
2. P02 — Durable Store / Event Ledger
3. P03 — Workspace / Ownership / Delivery Gate
4. P04 — Development Session Runtime / Zero3Executor binding
5. P05 — Scheduler

All five were developed from exact M0 `5b6a062f84e79037ac2e48da79e235c423bf36ac` and merged in the required order P01 -> P02 -> P03 -> P04 -> P05.

## Integration review

Static compare from M0 to the integrated code SHA confirms:

- Wave 1 added only `group-runtime/planning`, `store`, `workspace`, `session`, `scheduler` plus their Handoff/Manifest records;
- `group-runtime/contracts/**` C1 was not modified;
- existing `executor-runtime/**` red-zone code was not modified;
- worker path ownership did not overlap;
- no sibling branch was used as another worker's development baseline.

## Cross-module seams frozen for Wave 2

- P01 outputs C1-normalized definitions/requirements/sessions/waves.
- P02 is durable persistence only and exposes `DevelopmentGroupStore`.
- P03 is Git/worktree/ownership/Delivery evidence authority and reuses `zero3.pilot.handoff.v1`.
- P04 exposes narrow ExecutorManager/Store ports; P06 may adapt them to P02 and the existing Zero3Executor Manager without changing P04's contracts.
- P05 consumes durable runtime/evidence snapshots and never owns Codex Subagents.

## Validation status

- static merge/changed-path review: PASS;
- contract/planning/store/workspace/session/scheduler Node tests: `NOT_RUN`;
- real Git/Worktree behavior: `NOT_RUN`;
- real Codex Development Session behavior: `NOT_RUN`;
- Windows integration acceptance: `NOT_RUN`.

`SUCCESS_STATIC` means the Foundation merge is structurally accepted for the next development Wave. It is not a runtime test PASS.
