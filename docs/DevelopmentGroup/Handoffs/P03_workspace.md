# P03 — Workspace / Ownership / Delivery Gate

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `5b6a062f84e79037ac2e48da79e235c423bf36ac`

Implementation head: `da872d9e9d0542a27247399fc4b9859b9dbdc1a8`

## Delivered

- fixed-argv, `shell=false` Git workspace adapter;
- exact HEAD/branch/ancestry/diff/status evidence;
- Worktree create/remove operations without generic shell passthrough;
- glob-aware owned/read-only/forbidden/exception classification;
- deterministic workspace fingerprint;
- Delivery hash generation and C1 identity/scope checks;
- fail-closed Delivery Gate binding branch, HEAD, ancestry, changed paths, clean status and ownership;
- direct reuse of existing `zero3.pilot.handoff.v1` verifier and checkpoint hash rather than a duplicate Handoff protocol.

## Architecture

P03 owns workspace/delivery evidence only. It does not merge, schedule, execute Codex, approve permissions, or implement another Handoff authority.

## Static evidence

Changed paths are confined to `apps/zero3-desktop/group-runtime/workspace/**` plus this handoff/manifest. Existing `executor-runtime/handoff/**` is read-only and reused through public functions.

## Test status

- static review: completed;
- `workspace.test.ts`: authored, `NOT_RUN`;
- real Git/worktree Windows checks: `NOT_RUN`.

## Risks / M1 wiring

- Integration exceptions must be issued only by P07/P99 Red-Zone policy, never by a Worker Session.
- Worktree paths supplied by P01 are proposals; P03 is the runtime authority that creates/observes them.
