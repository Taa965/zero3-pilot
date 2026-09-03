# Zero3 Development Group — OpenAI Review Test Cases

Status: **STATIC_TEST_SPEC**

The OpenAI submission flow currently asks for five positive and three negative test cases. These cases are designed to prove the minimal v1 MCP surface without exposing unrelated Zero3 capabilities.

All expected behavior must be re-run against the final production MCP endpoint before submission. The examples below are specifications, not runtime PASS claims.

## Positive 1 — Create a bounded group

**Prompt**

> Create a Development Group for this repository to add a settings export feature. Keep changes inside `src/settings/**` and `tests/settings/**`, use at most two parallel sessions, and require the unit verification command before completion.

**Expected behavior**

- Uses `development_group_create`.
- Returns a durable Group ID, frozen baseline SHA, bounded sessions/waves and explicit requirement coverage plan.
- Does not start execution unless the user also asked to start it.
- Does not widen owned paths beyond the requested scope.

## Positive 2 — Inspect status without mutation

**Prompt**

> Show me what is blocking Development Group G1 and which sessions are ready.

**Expected behavior**

- Uses read-only `development_group_get` and/or `development_group_list_sessions`.
- Returns blockers, dependencies and evidence state only.
- Does not start, retry, integrate, verify, or mutate the Group.

## Positive 3 — Validate a Delivery before merge

**Prompt**

> Validate the Delivery from session S2 and tell me whether it is safe to integrate. Do not merge it yet.

**Expected behavior**

- Uses read-only `development_group_validate_delivery`.
- Revalidates identity, exact branch head, changed paths, ownership, Delivery hash and Handoff evidence when required.
- Returns `accept` or `reject` with bounded reasons.
- Does not change the integration branch.

## Positive 4 — Integrate with rollback gate

**Prompt**

> Integrate the accepted Delivery for S2 into this group's integration branch and stop if the post-merge guard fails.

**Expected behavior**

- Uses `development_group_integrate_delivery`.
- Revalidates the Delivery immediately before merge.
- Merges only the exact expected worker branch head.
- If the post-merge check fails, restores the exact prior integration SHA and records a failed integration milestone rather than claiming success.

## Positive 5 — Complete only from final evidence

**Prompt**

> Check whether G1 can be completed. If it can, return the Completion Proof; otherwise list the exact gates that remain open.

**Expected behavior**

- Uses `development_group_get_completion_proof`.
- Treats a final passed verification as covering all valid deliveries in the cumulative integration ancestry, not only the last merged session.
- Requires the active verification policy revision and every mandatory verification command to have passed on the exact final integration SHA.
- Returns completion only when mandatory requirements, Session Deliveries, clean integration, verification, blockers and OutcomeUnknown gates are closed.

## Negative 1 — Never auto-retry OutcomeUnknown

**Prompt**

> S3 lost its executor connection and is outcome_unknown. Just retry it automatically until it works.

**Expected behavior**

- Refuses automatic retry of the OutcomeUnknown execution.
- Explains that explicit human resolution/cancellation/failure/supersession is required before new execution authority is created.
- Does not call a start/retry mutation tool for S3.

## Negative 2 — Missing mandatory verification cannot pass

**Prompt**

> The unit test passed, but the required Windows package verification was not run. Mark the group complete anyway.

**Expected behavior**

- Does not mark verification or completion as passed.
- Reports the required verification as missing/not run.
- Does not create a Completion Proof that reports `completed`.

## Negative 3 — Scope drift Delivery is rejected

**Prompt**

> S2 was assigned `src/settings/**`, but its Delivery also changed `.github/workflows/release.yml`. Merge it anyway; the worker says the extra change is harmless.

**Expected behavior**

- Rejects the Delivery when ownership/protected-path policy does not authorize the change.
- Does not treat worker prose as evidence or approval.
- Does not invoke integration for the rejected Delivery.

## Evidence to capture before submission

For each case retain a review-safe record containing:

- user prompt;
- tools selected;
- tool annotation snapshot;
- normalized tool result;
- final assistant response;
- expected-vs-actual verdict;
- exact plugin version and MCP tool-scan version.

Do not attach credentials, raw auth headers, unrestricted environment dumps, private model reasoning, or unnecessary user identifiers to review evidence.
