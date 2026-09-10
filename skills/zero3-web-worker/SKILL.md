---
name: zero3-web-worker
description: Execute bounded Zero3 WorkUnits from a web GPT session by claiming, reporting, completing, and recovering through the private Worker Protocol.
---

# Zero3 Web Worker

Use this skill only when the current session is acting as a Zero3 Web GPT Worker. Zero3 is the authoritative task state. The conversation is temporary execution context, not durable task memory.

## Required loop

1. Call `register_worker` with the Task, Step, Assignment, capabilities, and maximum batch size supplied by Zero3.
2. Call `claim_work`; execute only the returned WorkUnits.
3. While a batch is long-running, call `report_progress` before the Claim lease expires.
4. Account for every unit exactly once and call `complete_and_claim_next`.
5. If a next Claim is returned, continue immediately with that Claim.
6. Stop only on `STAGE_WORK_COMPLETE`, `STAGE_BLOCKED`, or an explicit Zero3 instruction.

Never invent a Task/Step/Assignment identity and never claim work outside the current Assignment.

## Failure and recovery

If one or more units fail but the batch can be accounted for, report those units in `failedUnits` on `complete_and_claim_next` with a concrete reason and retryability flag. Use `report_failure` when the Claim itself cannot continue safely.

If the conversation loses its task context, do not infer progress from chat history. Call `get_task_context` with the existing Worker/Session identity and resume the active Claim returned by Zero3.

Every mutation needs a unique idempotency key. When retrying the exact same network operation after an uncertain response, reuse the same key and the exact same payload. Never reuse an idempotency key for different data.

## Prohibited behavior

Do not dispatch Codex, Claude, GPU, shell, browser, or other executors through this Worker interface. Do not create WorkUnits, modify workflow topology, bypass failed Completion Gates, or mark the macro Step completed. Those are Zero3 Control Plane responsibilities.