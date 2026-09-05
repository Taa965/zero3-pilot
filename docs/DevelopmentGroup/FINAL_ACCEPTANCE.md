# Development Group V1 — Final Integrated Acceptance

Status: **NOT_RUN**

This is the single final acceptance plan for Development Group V1. It is intentionally executed **after** the parallel implementation lanes are merged and wired. Individual lane tests may be authored earlier, but no lane-local `NOT_RUN` is upgraded to PASS by inference.

Acceptance candidate must be one exact Git SHA. Every result below is evidence for that SHA only.

## A. Candidate identity and repository hygiene

Required evidence:

- exact 40-character candidate SHA;
- current `HEAD` equals the candidate;
- working tree is clean before acceptance;
- frozen Development Group C1 files are unchanged from the approved contract baseline unless a separately approved ICR says otherwise;
- no sibling parallel branch is treated as a hidden runtime dependency.

Status: `NOT_RUN`.

## B. Unified static architecture gate

Run once on the integrated candidate:

```text
node scripts/check-architecture.mjs
node scripts/check-development-group-v1.mjs
```

The Development Group guard must prove at minimum:

- Runtime Facade uses the existing Executor boundary and does not launch a second Codex kernel;
- OutcomeUnknown remains fail-closed;
- mandatory verification is bound to exact evidence;
- Delivery/Handoff fingerprints use the authoritative R4E workspace capture;
- unsafe logical Handoff IDs are storage-encoded without changing logical identity;
- Renderer/Desktop bridge has explicit channels only, with no generic RPC/command surface;
- first OpenAI submission remains Skills-only and does not require MCP;
- optional MCP tool surface remains narrow and has no arbitrary command input.

Status: `NOT_RUN`.

## C. Unified Development Group behavior suite

Run the integrated behavior suite once, including Planning, Workspace/Delivery, Session Runtime, Controller, Integration, Verification, Completion, UI projection, Runtime Facade and Handoff.

Required scenarios include:

- dependency Waves and bounded concurrency;
- permission waits are never auto-approved;
- prompt/transport ambiguity becomes OutcomeUnknown;
- restart with an unowned active Session becomes OutcomeUnknown rather than fake-running;
- completed executor work materializes a Handoff-bound Delivery;
- scope drift is rejected;
- Integration revalidates Delivery and restores the exact prior SHA when a post-merge guard fails;
- restart reconstructs already-integrated dependencies from durable milestones;
- missing or platform-not-run mandatory verification cannot pass;
- final verification covers the cumulative integration ancestry, not only the last merged Session;
- Completion Proof fails while blockers, invalid Deliveries, missing mandatory evidence or OutcomeUnknown remain.

Status: `NOT_RUN`.

## D. Real temporary-Git / Worktree / Handoff acceptance

Use a disposable repository fixture, never the production project working tree.

Required evidence:

1. create baseline commit and integration branch;
2. create two Development Session worktrees with a dependency edge;
3. make an allowed committed change in Session 1;
4. build and persist R4E Handoff using the real logical DG task/execution IDs;
5. validate Delivery against independent Git and Handoff evidence;
6. integrate Session 1;
7. restart the controller/runtime process;
8. prove Session 2 becomes dependency-ready from durable Integration Milestones;
9. create a scope-drift change and prove Delivery rejection;
10. create a changed Handoff fingerprint after checkpoint capture and prove rejection;
11. induce post-merge guard failure and prove exact-SHA rollback.

Status: `NOT_RUN`.

## E. Real pinned-Codex Development Session acceptance

This requires the existing pinned open-source Codex runtime and a real permitted local execution environment.

Required evidence:

- the Development Session uses the existing `Zero3Executor` / Native Codex boundary;
- no second Codex app-server/Agent Kernel is spawned by the Group Runtime Facade itself;
- Session identity, workspace and permission profile remain bound;
- a real Session reaches `delivering` after an authoritative completed Turn;
- Supervisor returns control to the Desktop caller without waiting for the full Turn;
- completed work is converted to one Handoff-bound Delivery;
- killing/restarting the Desktop during an active unresumable prompt produces durable OutcomeUnknown, not an automatic retry;
- explicit user recovery is required before new authority is created.

Status: `NOT_RUN`.

## F. Windows Desktop integration acceptance

Run on Windows against the exact candidate SHA.

Required evidence:

- `apps/zero3-desktop` prepare succeeds from pinned upstreams;
- Development Group authoritative sources are staged into the Electron package tree;
- strict Desktop typecheck succeeds;
- `window.zero3DevelopmentGroup` exposes only the reviewed allowlisted methods;
- no Renderer generic Codex/Group RPC exists;
- Group list/get/start/integrate/verify/completion calls reach the one Runtime Facade instance owned by Electron main;
- a long-running Development Session does not freeze the renderer IPC call;
- normal desktop restart reconciles durable state fail-closed;
- Windows packaging succeeds and the packaged pinned Codex runtime still passes its existing smoke checks.

Status: `NOT_RUN`.

## G. OpenAI Plugin — first Skills-only submission acceptance

The first public submission is explicitly **Skills only**.

Required evidence:

- `.codex-plugin/plugin.json` parses and contains the final reviewed identity/metadata;
- no MCP/App connection is required by the first-review manifest;
- Skill remains useful with normal host coding/Git/test/delegation capabilities;
- Skill never claims durable Zero3 runtime evidence when that runtime is absent;
- `NOT_RUN` remains `NOT_RUN`;
- OutcomeUnknown is not automatically retried;
- scope drift is not authorized from worker prose;
- exactly five positive and three negative review cases are executed and captured;
- publisher identity, listing metadata, public website/support/privacy/terms fields are complete using real URLs only;
- release notes do not claim the optional MCP/runtime layer is part of the first submission.

Status: `NOT_RUN`.

## H. Optional Phase 2 MCP acceptance

This section is **not a blocker for the first Skills-only review**.

If/when MCP is added to a later public Plugin version, require separately:

- exact pinned MCP v2 server dependencies;
- stable public HTTPS MCP endpoint;
- OpenAI tool scan matches the intended eight-tool surface;
- annotations match actual side effects;
- no arbitrary command or generic RPC input;
- result minimization/credential filtering is verified;
- MCP-specific five-positive/three-negative cases pass against production.

Status: `NOT_RUN / NON_BLOCKING_FOR_V1`.

## Final release rule

Development Group V1 may be marked `ACCEPTED` only when sections A–G have explicit evidence on the same exact candidate SHA and no required item remains `NOT_RUN`, `FAILED`, `BLOCKED` or `OUTCOME_UNKNOWN`.

Do not convert authored tests, a previous SHA, another platform, an earlier PR workflow, or static code inspection into final acceptance evidence.
