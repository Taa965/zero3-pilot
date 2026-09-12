# Zero3 Autonomous Task Runtime v1.3 — Implementation Baseline

## 2026-09-12 Post-Plugin / Post-Main Re-baseline

The v1.3 branch has been merged forward with current `main` and now consumes the production Zero3 capability/agent stack instead of maintaining a parallel executor router.

- **Root Goal entry is live in the Task Board.** A user can create an autonomous goal with title, final objective, importance and optional required capabilities. The Root Goal is an authoritative Execution Runtime Task with one AUTO entry step and `autonomyLevel: L4` metadata.
- **Non-Web-GPT execution reuses `Zero3AgentRuntimeOrchestrator.dispatchAgentTask`.** Executor selection, availability, routing history, failover and verification profile stay owned by the unified Intelligent Agent Task Router. ATR no longer lists providers or scores executors itself.
- **Execution results are reconciled back into the authoritative Execution Runtime.** ATR creates the Execution Assignment/Session Binding and moves successful work through `completion.requested -> gate.passed`; Agent Runtime result state never becomes a second Task authority.
- **Structured Runtime Guards are connected.** Execution events, GPT Web execution health, Workflow Worker blocked/rotation events, Capability Operation failures/timeouts, and Remote Compute connectivity are normalized into Intake Candidates. Guard sources never create Tasks directly.
- **Planner is context-aware and proposal-only.** It prioritizes unresolved candidates by disposition, severity and mainline impact, detects missing capabilities and emits ESCALATE/EXECUTE/DEFER/OBSERVE proposals. Materialization remains an Orchestrator/Policy action.
- **Task Board exposes the autonomy control surface.** The same Task Board shows Root Goal/AUTO badges and a `自主编排` view for Daily Review, Human Attention, next actions and Execution Graph. No autonomous-only Task Store or board authority exists.
- The autonomous loop and auto-dispatch are enabled by default in the prepared desktop composition but can be explicitly disabled through the existing environment flags.

Status: branch implementation baseline for `codex/autonomous-task-runtime-v1.3`.

## Delivery ordering

v1.3 is designed for the system state **after** the separate Zero3 Pilot Plugin VNext plan is completed and accepted. This branch does not broaden the current bounded Web GPT MCP surface to pretend that future state already exists.

The runtime therefore exposes a **Plugin Capability Gate**. Autonomous paths that depend on future plugin authority fail closed until the required capabilities are advertised.

### CURRENT

The repository already owns these authoritative runtimes:

- Execution Runtime — Task / Step / Assignment / Dependency authority.
- Completion Gate — final completion authority.
- Worker Runtime — Worker Slot / Physical Session / Claim / Lease authority.
- Memory Authority — shared organizational memory authority.
- Artifact Runtime — artifact metadata authority.
- GPT Web Runtime — physical web conversation and health authority.
- Existing Skill capability preflight/routing — Skill availability and executor recommendation.

The current Web GPT Fast Path remains bounded. v1.3 does not grant it raw shell, filesystem, control-token or full-Codex authority.

### REQUIRED_POST_PLUGIN

Before cross-agent autonomous execution is treated as fully available, Plugin VNext must advertise:

- `zero3.full-capability.web-gpt`
- `agent.dispatch.unified`
- `agent.dispatch.codex.full`
- `session.bootstrap.project`
- `memory.shared.lifecycle`

Missing capabilities produce fail-closed / Human Attention behavior, not a security bypass.

## No duplicate authority

Autonomous Task Runtime is a product capability. The technical layer is an Autonomous Orchestrator over existing authorities.

It does **not** create a second Task, Worker, Memory, Artifact, Session or Completion authority. `autonomous_task_intake` is governance/intake state only; Execution Runtime remains the only Task status source.
## Intake governance

Discovery is not equivalent to task creation.

Every memory/runtime candidate is normalized and assigned:

- category
- severity
- confidence
- affected resources
- mainline impact
- disposition
- decision reason
- rootTaskId / parentTaskId
- attention cost

Disposition is one of:

- `IGNORE`
- `OBSERVE`
- `DEFER`
- `PARALLEL`
- `INTERRUPT`

Only `PARALLEL` and `INTERRUPT` materialize/reuse an Execution Task. Warnings default to DEFER unless explicit blocking evidence exists. This prevents incidental warnings from recursively creating work.

Semantic dedupe keeps canonical source identity and problem-text dedupe, with governance context (category/resources/root task) folded into new fingerprints while retaining compatibility with earlier fingerprints.

## Lineage and mainline protection

Autonomous Tasks store provenance in Execution Task metadata:

- rootTaskId
- parentTaskId
- parentStepId
- sourceCandidateId
- source event/entity refs
- creationReason
- resumeParentOnComplete
- childDepth

An `INTERRUPT` candidate blocks the originating parent step/task through existing Execution Runtime APIs before the repair runs.

Attention budgets bound automatic fan-out:

- maxChildDepth
- maxParallelAutoTasks
- maxAutoSpawnPerRoot
- maxRetries
- maxAutonomousSessions

Budget exhaustion changes execution disposition to DEFER and records Human Attention instead of spawning recursively.
## Parent Resume

A completed repair is not the end of the workflow.

For a child with `resumeParentOnComplete`:

1. authoritative child Completion Gate must have completed the child task;
2. the originating intake is marked resolved;
3. a durable `autonomous_parent_resume` receipt is created;
4. parent step/task is unblocked through Execution Runtime state transitions;
5. readiness is reconciled;
6. normal scheduler/dispatch resumes the mainline;
7. the receipt becomes `RESUMED`.

The receipt makes resume idempotent across repeated reconciliation and restart. Unsafe parent states move the receipt to `WAITING_HUMAN` rather than guessing.

## Capability routing

v1.3 routes from required capability to providers rather than growing agent-specific business switches.

`Task / Issue -> required capabilities -> candidate providers -> Scheduler / Policy`.

Existing Skill preflight remains an input. Current GPT launch remains a concrete adapter. Future Plugin VNext connects unified agent dispatch to the same router. When the production capability baseline is advertised, non-GPT work is delegated to the unified Agent Runtime. Missing/disabled capabilities and unsupported executors continue to fail closed into Human Attention.

## Runtime Guard intake

Typed guard contracts cover:

- GPT Web health
- Execution Runtime
- Worker Runtime
- Git/development
- Compute/node
- Tool/MCP
- Artifact/Completion

A guard only creates an intake candidate/reference. It never creates a Task directly. Assistant prose is not the primary error-detection mechanism.

## Reconciliation

Periodic reconciliation remains a safety net. v1.3 additionally exposes project-scoped event-triggered reconciliation. A per-project promise tail serializes concurrent requests so event-triggered and periodic reconciliation remain idempotent.
## Planner contract

Planner output is a versioned `PlanProposal`. It may propose EXECUTE / DEFER / OBSERVE / ESCALATE actions but has no direct Execution Runtime mutation capability. Only Policy + Orchestrator materializes authoritative tasks.

The branch now includes a deterministic context-aware planner over authoritative Tasks, unresolved Intake records and advertised capabilities. It remains proposal-only; richer LLM planning can replace proposal generation without gaining Task mutation authority.

## Projection-only views

The following are data projections, not new authorities:

### Human Attention

Projects unresolved intake records that require intervention: missing plugin capability, budget exceeded, unsafe recovery, no safe executor, or failed closed dispatch.

### Execution Graph

Projects authoritative Task, Candidate and Session records into edges such as:

`root task -> candidate -> child task -> session`.

### Daily Review

Projects user/root task count, autonomous task count, candidate count, disposition breakdown, resolved/open candidates and Human Attention count.

No second event store is introduced.

## Validation contract

The v1.3 regression set covers:

1. warning -> DEFER and no Task;
2. blocking issue -> INTERRUPT and one child Task;
3. duplicate reports -> one logical Task;
4. root/parent lineage metadata;
5. attention budget prevents recursive spawn;
6. completed repair -> Parent Resume exactly once;
7. missing Plugin VNext capability -> fail closed + Human Attention;
8. event-triggered + periodic reconciliation remains idempotent;
9. legacy intake SQLite migrates without data loss;
10. Planner proposal cannot directly mutate Execution authority.

Architecture guard: `node scripts/check-autonomous-task-runtime-v1-3.mjs`.

Behavior tests:

```sh
node --experimental-transform-types --test \
  apps/zero3-desktop/worker-runtime/v2/autonomous-task-loop.test.ts \
  apps/zero3-desktop/worker-runtime/v2/autonomous-orchestrator.test.ts
```

## Merge gate

The current mainline supplies Remote Capability P0 and unified production Agent dispatch. ATR treats those as the post-plugin baseline and still fails closed whenever the capability gate is not ready. Full production acceptance remains a separate test phase after all code is landed.