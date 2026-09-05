# Zero3 Development Group — Review-facing MCP Tool Contract

Status: **DESIGN_FROZEN_FOR_IMPLEMENTATION**

This document defines the minimal public MCP surface intended for the first OpenAI Plugin review. It deliberately does **not** expose generic shell execution, arbitrary Codex RPC, browser control, computer control, provider switching, credential operations, or the wider Zero3 Pilot control plane.

The first submission surface is limited to persistent coding orchestration: plan -> sessions/waves -> Delivery validation -> integration -> verification -> completion proof.

## Tool set

| Tool | Purpose | `readOnlyHint` | `openWorldHint` | `destructiveHint` |
| --- | --- | --- | --- | --- |
| `development_group_create` | Create a durable Development Group from an explicit coding goal and repository scope. | `false` | `false` | `false` |
| `development_group_get` | Read Group definition, runtime status, blockers, progress and current evidence summary. | `true` | `false` | `false` |
| `development_group_list_sessions` | List bounded Development Sessions, dependencies, assigned requirements and current states. | `true` | `false` | `false` |
| `development_group_start_wave` | Start eligible sessions in one dependency wave within frozen concurrency/attempt/permission policy. | `false` | `false` | `false` |
| `development_group_validate_delivery` | Re-run Delivery identity, Git/worktree, ownership and evidence gates without merging. | `true` | `false` | `false` |
| `development_group_integrate_delivery` | Revalidate and merge one accepted Delivery into the configured integration ref, with rollback on failed post-merge checks. | `false` | `false` | `false` |
| `development_group_run_verification` | Run the explicit verification command set bound to an exact integration SHA and policy revision. | `false` | `false` | `false` |
| `development_group_get_completion_proof` | Build/read the fail-closed completion proof and explain unresolved gates. | `true` | `false` | `false` |

## Annotation rationale

OpenAI review treats any tool that creates state, starts workflows, runs jobs, writes logs, or changes a repository as non-read-only. Therefore `create`, `start_wave`, `integrate_delivery`, and `run_verification` advertise `readOnlyHint: false` even when an individual call might not change source files.

The v1 tools do not intentionally communicate with arbitrary third-party services, so `openWorldHint` remains `false`. If a future tool pushes to GitHub, sends notifications, calls external CI, or otherwise interacts with an open-world service, that tool must be split or re-annotated rather than silently widening this contract.

The v1 surface does not expose delete, force-reset, overwrite, credential revocation, irreversible publishing, or other destructive actions. If such a capability is added later, it must be a separate explicitly destructive tool with host confirmation; do not hide it behind a mode flag on a non-destructive tool.

## Input constraints

All state-changing tools must require enough identity to prevent cross-project or stale-run mutation:

- `groupId`;
- repository identity;
- exact baseline or integration SHA when relevant;
- `sessionId` / `executionId` / Delivery hash when relevant;
- expected integration ref for merge operations;
- explicit policy revision for verification.

Identifiers received from the client are untrusted. The server must resolve them against durable Group records and fail closed on mismatch.

No tool accepts a generic command string for arbitrary execution. Verification commands come from the frozen Group policy/plan and are returned to the user for inspection as structured metadata.

## Result minimization

MCP results must return only fields necessary for the requested workflow. Do not return:

- auth tokens, API keys, cookies or credential files;
- raw environment dumps;
- private provider exceptions or stack traces;
- internal trace/request IDs that are not needed by the user;
- unrelated file contents or logs;
- hidden prompts or model reasoning.

When command evidence is needed, return bounded evidence identifiers, exit status, normalized failure category, and user-relevant excerpts rather than unrestricted raw logs.

## Fail-closed behaviors

The MCP server must never:

- infer approval from a natural-language worker message;
- auto-retry `outcome_unknown`;
- integrate a Delivery whose branch head, identity, ownership, Handoff, or Delivery hash gate fails;
- mark verification passed when a mandatory command is absent, optional, `not_run`, `not_run_platform`, failed, or bound to another integration SHA/policy revision;
- mark a Group complete while mandatory Requirements are unverified/unwaived, any planned Session lacks a valid completed Delivery, integration is not clean, blockers remain, or OutcomeUnknown is non-zero.

## Public-review implementation gate

This document is a contract, not proof that the public MCP server exists. Public submission remains blocked until the server is deployed at a stable production HTTPS URL and its scanned tool metadata exactly matches this contract.
