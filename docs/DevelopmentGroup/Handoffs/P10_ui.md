# P10 — Development Group View Model

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `382c4ced5f9b765545e71776468de32fa6f4f237` (M1)

Implementation head before handoff record: `527c6cecda07a5673e99e69cd3dcf1a2a0460ab7`

## Delivered

- provider-neutral Group summary projection;
- Session cards with dependency, attempt, blocker and attention state;
- Requirement matrix projection;
- Wave integration progress;
- Verification result counters;
- Failure, Repair and Integration timeline data surfaces.

## Closeout repair

Static review found the same cumulative-verification error that P09 had in its evidence matrix: UI verification state was tied to each Session's individual Integration Milestone head. P10 now walks the final verified integration ancestry and projects all Sessions present in that exact final chain as verified, while also requiring the active verification-policy revision and mandatory command evidence.

## Architecture

P10 is a pure view-model layer. It does not start sessions, merge branches, execute verification commands, change approval state, or expose generic Codex RPC.

## Test status

- static review: `PASS`;
- view-model tests for cumulative verification and stale-policy rejection: authored, `NOT_RUN`;
- renderer binding/visual acceptance: `NOT_RUN`;
- Windows UI acceptance: `NOT_RUN`.

## Integration notes

This lane intentionally stops at the view-model boundary. A later desktop/renderer wiring step must consume these projections without moving execution authority into the Renderer.
