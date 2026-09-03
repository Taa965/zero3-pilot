# P08 — Verification / Failure Attribution / Repair Planning

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `382c4ced5f9b765545e71776468de32fa6f4f237` (M1)

Implementation head before handoff record: `d0da74a5e702e9b9fe94eb59f12b6bef1b355a18`

## Delivered

- exact-integration-SHA Verification Run construction;
- platform-aware command results with required `not_run_platform` treated as incomplete;
- executor exceptions normalized to Verification `outcome_unknown` rather than inferred failure;
- failure attribution by normalized failure kind, session identity and owned changed paths;
- bounded repair-wave planning by owner, same-failure attempt budget and repair-session budget;
- OutcomeUnknown and unattributed/over-budget failures routed to human resolution.

## Closeout repair

Static review found that policy-mandatory verification IDs could be checked by a helper but were not enforced at the verification execution entry. `executeVerification` now accepts the mandatory ID set and fails closed when any mandatory command is missing or marked optional.

## Architecture

Verification does not invent arbitrary commands. M2 wiring must supply the frozen Group verification command set/policy. Repair planning does not create new authority for OutcomeUnknown.

## Test status

- static review: `PASS`;
- verification/failure/repair tests: authored/updated, `NOT_RUN`;
- actual commands and platform runners: `NOT_RUN`;
- Windows integrated verification: `NOT_RUN`.

## Integration notes

P09 must only accept a passed Verification Run that matches the final integration SHA, active policy revision and complete mandatory command set.
