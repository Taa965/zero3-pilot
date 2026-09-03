---
name: zero3-development-group
description: Plan, monitor, verify, integrate, and close evidence-gated coding work through a Zero3 Development Group. Use when the user wants persistent multi-session development orchestration rather than a single coding turn.
---

# Zero3 Development Group

Use this skill for a coding goal that benefits from bounded development sessions, explicit dependency waves, durable delivery evidence, integration gating, verification, repair attribution, and a fail-closed completion proof.

## Core workflow

1. Normalize the user's goal into explicit requirements and acceptance criteria.
2. Propose bounded Development Sessions with non-overlapping ownership and dependency edges.
3. Keep the plan frozen while sessions execute; do not silently widen scope.
4. Treat a worker's natural-language claim of completion as non-evidence.
5. Accept a Delivery for integration only after identity, Git/worktree ownership, and delivery evidence gates pass.
6. Integrate in dependency order and preserve an exact integration SHA chain.
7. Bind verification to the exact final integration SHA and the active verification-policy revision.
8. Attribute failures before proposing bounded repair work. Never automatically retry OutcomeUnknown.
9. Mark the group complete only after the Completion Proof closes every mandatory requirement, delivery, integration, verification, blocker, and OutcomeUnknown gate.

## Safety and authority

- Open-source Codex remains the native Agent Kernel; this skill does not create a second model/tool/approval/subagent loop.
- Never bypass approval, sandbox, Handoff, ownership, or Delivery gates.
- Never infer `approved`, `verified`, `integrated`, or `completed` from prose alone.
- Do not auto-resolve `outcome_unknown`; require explicit human resolution, cancellation, failure, or supersession.
- Keep writes scoped to the repository, branch, worktree, paths, and writer generation assigned to the Development Session.
- Destructive or irreversible actions require the corresponding tool to advertise destructive behavior and must follow host confirmation policy.

## Tool use

When the Zero3 Development Group MCP tools are installed, prefer their structured records over free-form reconstruction. Read-only inspection should use read-only tools. Starting work, accepting deliveries, integrating branches, creating repairs, or completing a group are writes and must be treated as state-changing operations.

The review-facing MCP contract is documented in `../../MCP_TOOL_CONTRACT.md`. Do not invent a tool call when the installed plugin does not expose that tool. If the MCP server is not connected, explain that structured Zero3 operations are unavailable and limit the response to planning or analysis that does not claim durable execution.

## Completion language

Use precise status language:

- `planned`: proposal exists but execution evidence does not.
- `delivered`: worker produced a structured Delivery; not yet integrated.
- `integrated`: Delivery is merged into the integration chain; not yet verified.
- `verified`: evidence passed against the required integration SHA and policy.
- `completed`: a valid Group Completion Proof exists with no unresolved blockers or OutcomeUnknown.

Never collapse those states into a generic "done" status.
