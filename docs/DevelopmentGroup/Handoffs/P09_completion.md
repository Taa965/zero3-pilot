# P09 — Requirement Matrix / Completion Proof

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `382c4ced5f9b765545e71776468de32fa6f4f237` (M1)

Implementation head before handoff record: `7051f46f4972a19cefef311e98eb6e7eb18c444e`

## Delivered

- deterministic Requirement evidence matrix from planned -> assigned -> implemented/tested -> integrated -> verified/waived;
- fail-closed Group Completion Proof using frozen `zero3.pilot.group-completion-proof.v1`;
- mandatory Requirement coverage, valid Session Delivery coverage, clean integration, verification evidence, blocker and OutcomeUnknown gates;
- strict completion mode waiver rejection;
- exact final integration SHA and verification-policy binding.

## Closeout repairs

Static review found two completion risks and closed both without changing C1:

1. Earlier sequentially merged Sessions were left at `integrated` because only a milestone whose own `headSha` equaled the final SHA could become verified. The matrix now walks the cumulative merged Integration Milestone ancestry (`headSha -> baseSha`) and lets one valid final-SHA verification cover every Delivery actually present in that final chain.
2. A nominal `passed` Verification Run was not independently checked against the active policy revision and full mandatory-test set at Completion Proof construction. P09 now requires exact policy revision plus every mandatory command marked required and passed.

Ambiguous merged milestones with the same head and integration ancestry cycles fail closed.

## Architecture

P09 consumes evidence; it does not run tests, merge code, manufacture waivers, or infer completion from worker prose.

## Test status

- static review: `PASS`;
- completion tests including cumulative integration ancestry and stale-policy rejection: authored/updated, `NOT_RUN`;
- full M2 end-to-end completion flow: `NOT_RUN`;
- Windows acceptance: `NOT_RUN`.
