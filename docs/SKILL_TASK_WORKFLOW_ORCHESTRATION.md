# Zero3 Skill × Task × Workflow 能力编排

## Architecture

Codex Native Skills remains the only Skill source of truth. Execution Task and Workflow layers store only selectors, preflight evidence, routing decisions and usage relationships; they never copy `SKILL.md` into a second registry.

```text
Execution Step.requiredSkills / optionalSkills
        ↓
Codex skills/list + Zero3 relation-only bindings
        ↓
Skill Preflight
        ↓
Scheduler Capability Gate
        ↓
Agent routing / Assignment
        ↓
Task Ledger + skill.preflight events
```

## Step contract

`ExecutionStepDefinition` supports:

- `requiredSkills?: string[]` — missing/disabled/unsupported blocks dispatch.
- `optionalSkills?: string[]` — recorded in preflight but does not block dispatch.
- Existing Steps without Skill declarations remain backward compatible.

`ExecutionTaskDefinition.workspace` optionally supplies the project cwd used for repo-scoped Codex Skill discovery.
## Preflight and routing

Preflight records:

- selected executor;
- adapter mode (`native`, `instruction-adapter`, `web-mcp`, `unsupported`);
- required/optional Skill selectors;
- available and missing Skills;
- check timestamp.

The Scheduler exposes `capabilityBlockedStepIds` and excludes a Step from `dispatchableStepIds` until every required Skill is ready. Assignment creation repeats the gate, so a caller cannot bypass the Scheduler.

For `AUTO` Steps, the desktop capability provider chooses among currently available agents. Current preference is Codex, Claude, then Antigravity, with explicit Agent Skill bindings receiving a strong routing boost. The resulting executor is persisted in Skill preflight and must match the Assignment.

Web GPT lifecycle claims also refresh Skill preflight. A Web GPT worker may claim an explicit `GPT_WEB` Step, or an `AUTO` Step whose required Skill preflight recommends `GPT_WEB`; it cannot steal an AUTO Step routed to Codex/Claude/Antigravity.

## Agent adapter matrix

- `CODEX` / `ZERO3`: native Codex Skill UserInput.
- `CLAUDE`: instruction adapter over the same original Codex `SKILL.md`.
- `ANTIGRAVITY`: instruction adapter over the same original Codex `SKILL.md`.
- `GPT_WEB`: isolated `/mcp/skills` web-mcp path when Skill Tunnel is enabled.
- Unsupported executors fail required Skill preflight closed.
## Workflow compatibility

`workflowId` remains the Task-to-Workflow identity used by the existing relation-only Skill Router. Workflow bindings continue to participate in Skill selection. Worker Protocol v2 keeps its legacy single `WorkflowWorkUnit.skill` field unchanged so existing workers and stored StageRuns do not need migration.

New Execution workflows should express capability requirements at Step level with `requiredSkills` / `optionalSkills`; legacy Worker v2 Skill references remain accepted during the transition.

## UI

The Tasks module now reads the real persistent Execution Task Ledger instead of fixed demonstration data.

Task details expose:

- Step Skill tags;
- Skill preflight ready/blocked state;
- missing required/optional Skills;
- adapter mode and routed executor;
- real Assignments and Session Bindings;
- Agent Capability Matrix;
- real Task event timeline including `skill.preflight`.

The Skills module also exposes the Agent Capability Matrix as a stable management surface.

## Acceptance scenario

The regression suite includes a two-stage cognitive-store workflow:

1. `script-rewrite` requires `cognitive-store-script` and is routed to Codex.
2. `visual-plan` depends on script completion, requires `cognitive-store-visual`, stays capability-blocked until its own preflight, then routes to Claude through the instruction adapter.

This proves dependency readiness and capability readiness are separate gates.
