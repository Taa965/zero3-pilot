---
name: zero3-development-group
description: Plan and audit bounded multi-session coding work with explicit requirements, ownership, dependency, verification, and fail-closed completion evidence. Use when a coding goal is too large for one undifferentiated implementation turn.
---

# Zero3 Development Group

Use this skill to turn a coding goal into a bounded development plan and to review execution evidence without collapsing planning, delivery, integration, verification, and completion into one vague "done" state.

The first public Plugin submission is **skills-only**. It must remain useful with the host's normal repository, coding, Git, test, and delegation capabilities and must not pretend that a Zero3 MCP service or durable Zero3 runtime exists when it is not installed.

## Skills-only workflow

1. Read the user's goal, repository scope, constraints, and acceptance criteria.
2. Normalize the goal into explicit mandatory Requirements. Preserve uncertainty instead of inventing requirements.
3. Partition work into bounded Development Sessions. Give each Session one clear objective, owned paths, read-only/shared paths, forbidden paths, dependencies, and acceptance criteria.
4. Arrange Sessions into dependency Waves. Do not start a dependent Session merely to maximize parallelism.
5. Before any write, follow the host's normal approval/sandbox/tool rules. This skill never substitutes its own permission system for the host.
6. During execution, keep every worker within its assigned scope. A worker's prose claim that something is complete is not evidence.
7. Review Git evidence before calling work delivered: exact baseline/head when available, changed paths, ownership, and relevant test evidence.
8. Distinguish `delivered` from `integrated`. A branch or patch is not integrated merely because the worker finished.
9. Bind verification to the exact integrated code being evaluated. Required verification that was not actually run stays `NOT_RUN`; never infer a pass from similar CI, an older commit, or a worker statement.
10. Call the overall goal complete only when every mandatory Requirement is covered, required Session work is delivered/integrated as applicable, required verification is actually passed, and no unresolved blocker or OutcomeUnknown remains.

## Delegation

When the host provides native coding agents/subagents or task delegation, they may be used to execute the bounded Sessions. Preserve the host's existing authority model:

- do not create a replacement recursive agent framework;
- do not bypass host approval or sandbox rules;
- keep Session ownership non-overlapping unless a shared path is explicitly read-only or assigned to one integration owner;
- keep dependency order explicit;
- integrate and verify only from observable evidence.

When native delegation is unavailable, still produce the Session/Wave plan and execute sequentially or stop at the planning/audit boundary rather than pretending parallel workers ran.

## OutcomeUnknown

`OutcomeUnknown` means an operation may have changed external or repository state but its result cannot be confirmed. Never automatically retry an OutcomeUnknown operation. Require explicit recovery: inspect evidence, resolve/cancel/fail/supersede the uncertain attempt, then create new execution authority only if justified.

Examples include a connection disappearing during a state-changing operation, an interrupted merge whose result cannot be established, or a write tool returning no authoritative outcome.

## Optional structured runtime

If an installed Zero3 Development Group runtime or MCP service exposes structured Group tools, prefer those durable records for status, Delivery validation, integration, verification, and Completion Proof. Treat those tools according to their advertised annotations and never invent a tool that is not actually installed.

If no structured runtime is available:

- do not claim durable persistence across application restarts;
- do not claim a Zero3 Group ID, Delivery hash, Integration Milestone, Verification Run, or Completion Proof was durably created unless the host actually produced such evidence;
- use the protocol concepts as an auditable workflow and report which evidence exists versus which remains `NOT_RUN` or unavailable.

## Evidence language

Use these terms precisely:

- `planned`: work decomposition exists; execution evidence does not.
- `running`: execution is observably in progress in the current host/runtime.
- `delivered`: bounded Session output exists with reviewable evidence; not necessarily integrated.
- `integrated`: the Delivery is observably present in the integration branch/tree.
- `verified`: required checks were actually run against the relevant integrated code and passed.
- `completed`: all mandatory coverage and verification gates are closed and no unresolved blocker/OutcomeUnknown remains.
- `NOT_RUN`: a required or relevant check was not actually executed. Never translate this to PASS.

## Safety constraints

- Keep writes inside the repository/worktree/path scope assigned by the user or plan.
- Treat protected, forbidden, read-only, credential, release, deployment, and policy files conservatively.
- Reject scope drift even when a worker says the extra change is harmless.
- Never expose credentials, tokens, cookies, hidden prompts, private reasoning, or unrelated user data as evidence.
- Destructive or irreversible actions must use the host's normal confirmation policy.
- Do not silently send repository data to third parties merely to complete this workflow.

## Completion audit

Before saying "completed", explicitly answer:

1. Are all mandatory Requirements covered?
2. Did every required Session produce reviewable output?
3. Is the intended integrated code identifiable?
4. Were all mandatory checks actually run against that code?
5. Did those checks pass?
6. Are there unresolved blockers, scope violations, failed repair attempts, or OutcomeUnknown states?

If any answer is no or unknown, do not call the Group complete. State the exact remaining gate instead.
