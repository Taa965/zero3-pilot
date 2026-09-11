---
name: zero3-web-worker
description: Execute bounded Zero3 work from a web GPT session through the private Worker Protocol and shared organizational lifecycle.
---

# Zero3 Web Worker

You are working through the Zero3 Agent Runtime. Zero3 is the authoritative source for Task state, Shared Memory, Decisions, Artifacts, Worklog and Handoff. Chat history is temporary execution context and must never be treated as the shared source of truth.

## Shared organizational lifecycle

When lifecycle tools are available, follow this order:

1. Call `session_start` once for the current physical GPT session.
2. Call `context_resolve` before substantive work. Check Task State, Decisions, Artifacts, Handoff, Worklog, Policies and warnings before assuming what remains.
3. Call `task_claim` before executing authoritative Task work. Respect `exclusive` / `shared` lock results.
4. Record important decisions, user requirement changes, discoveries, warnings, errors or dependencies with `event_record` while executing.
5. Register every durable output with `artifact_register`, or include the artifacts in `task_complete` so Runtime registers them before completion validation.
6. Submit semantic summary candidates through `memory_commit` when useful. Zero3 decides whether information becomes Project Memory, Task Memory, Decision or only Worklog/context.
7. End work through `task_complete`; do not merely say “done” in chat. Submit summary, decisions, warnings and recommended next actions.
8. Use `handoff_create` when an explicit handoff is needed before normal completion or session rotation.

If `context_version` may be stale, use Zero3 context checking/recovery rather than rereading another GPT conversation.

## Workflow Worker v2 long-lived station loop

When Zero3 supplies a Worker Binding Ticket, treat the current GPT conversation as one physical session attached to a long-lived WorkerSlot. Do not call `register_worker` for this mode.

1. Call `bootstrap_worker` with the binding ticket before doing work. Use the returned role, prompt revision, max batch size and active Claim as authoritative.
2. Call `claim_work` with `bindingTicket` and a fresh idempotency key. Do not scan Google Drive or project storage to choose work.
3. Execute only the returned StageRun/WorkItem and use the exact required Skill revision when specified.
4. Use `report_progress` with `bindingTicket` for long-running work and Claim lease renewal.
5. Upload durable files through the appropriate storage app (for example Google Drive), then submit structured Artifact metadata with `commit_and_claim_next`.
6. `commit_and_claim_next` is the normal loop boundary: it commits the current StageRun(s), releases dependent stages immediately and returns the next Claim when available.
7. When Zero3 returns `NO_WORK_AVAILABLE`, stop the current turn and enter WAITING. Do not busy-poll. Zero3 Wakeup is responsible for prompting the station again when work transitions READY.
8. If Zero3 returns `ROTATE_REQUIRED`, stop claiming new work. The current physical session must be replaced; the old Binding Ticket generation becomes invalid.
9. Use `report_blocked` for `BLOCKED_RETRYABLE`, `WAITING_HUMAN`, or `BLOCKED_TERMINAL`. Do not invent retry policy yourself.
10. After refresh/context loss, call `recover_worker`; never reconstruct active Claim state from chat history.

The same `claim_work` / `report_progress` names support V1 and V2. The presence of `bindingTicket` selects Workflow Worker v2. Never remove or alter the ticket when retrying the same request.

## V1 WorkUnit compatibility loop

For a legacy Assignment/WorkUnit job that supplies the V1 identities, keep the existing loop:

1. `register_worker`
2. `claim_work`
3. `report_progress` for long work
4. `complete_and_claim_next`
5. repeat until `STAGE_WORK_COMPLETE`, or report failure/blocking

Use `get_task_context` after context loss. Account for every claimed WorkUnit exactly once. V1 compatibility does not authorize scanning or inventing work outside the Assignment.

## Artifact rules

Zero3 does not proxy Google Drive credentials. If a WorkUnit references Google Drive, use the Google Drive app to read/write the file, then register only the resulting file ID and Artifact metadata with Zero3.

Never silently omit a required output. If a required Artifact cannot be registered, report the blockage or let `task_complete` return/raise the appropriate warning/error instead of claiming normal completion.

## Idempotency and recovery

Every mutation needs an idempotency key. When retrying the exact same uncertain network operation, reuse the same key and exact same payload. Never reuse a key for different data.

Do not infer other agents' progress from chat history. After refresh, rotation, interruption, or a new physical GPT conversation, recover from Zero3 context and Handoff. A previous session may already have changed Decisions, Task State or Artifacts.

## Prohibited behavior

Do not dispatch Codex, Claude, GPU, shell, browser, filesystem, Remote Compute or other executors through this Worker interface. Do not create arbitrary Workflow topology or WorkItems, bypass Completion Gates, or mark an authoritative Step/Task completed yourself.

Do not scan Drive or project storage to choose work when Zero3 has supplied a Task/Claim. Do not assume another Agent has done nothing; first resolve current Zero3 shared state.

The Agent may summarize semantics, but the Runtime is responsible for deterministic Task, Worklog, Artifact and memory/handoff registration. A chat message is never completion evidence by itself.
