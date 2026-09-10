# Zero3 Web-GPT Worker Protocol v1

## Purpose

Web GPT is an execution worker, not the Zero3 scheduler. The protocol lets a ChatGPT web session repeatedly claim bounded WorkUnits, report progress, finish a batch, and atomically receive the next batch while Zero3 remains the durable authority.

The protocol deliberately does **not** expose Codex, Claude, GPU, remote-compute, workflow-editing, or arbitrary local-command tools. Those decisions stay inside Zero3 Pilot.

## Authority boundary

```text
Zero3 Execution Runtime (Task / Step / Assignment / Completion Gate)
                         |
                 Worker Runtime
          (WorkUnit / Claim / Lease)
                         |
                private MCP tools
                         |
                    Web GPT
```

A Worker may finish every WorkUnit assigned to a Step, but that only produces `STAGE_WORK_COMPLETE` / `completion.requested`. It does not mark the macro Execution Step `completed`; the existing Zero3 Completion Gate remains authoritative.
## Web MCP surface

The private Web GPT adapter exposes exactly six task-scoped tools:

- `register_worker`: register a web session and its capabilities / maximum batch size.
- `claim_work`: atomically claim the next available WorkUnits.
- `report_progress`: report activity and renew the Claim lease.
- `complete_and_claim_next`: close the current Claim and claim the next batch in one SQLite transaction.
- `report_failure`: record Claim failure and requeue retryable units.
- `get_task_context`: recover authoritative state after context/session loss.

`complete_and_claim_next` requires every unit in the Claim to be reported exactly once as completed or failed. All mutating calls carry an idempotency key; replaying the same request returns its stored response, while reusing the key for different input fails closed.

## Local Zero3 administration

The desktop application has a separate local-only IPC surface for `ensureStage`, `addWorkUnits`, `stageSnapshot`, and `expireLeases`. These administration methods seed and inspect work; they are intentionally not registered as Web GPT MCP tools.

The Worker database is stored under the Zero3 user-data directory as `worker-runtime.sqlite3`. It uses SQLite WAL, `synchronous=FULL`, `busy_timeout`, and `BEGIN IMMEDIATE` transactions so concurrent web workers cannot claim the same unit.
## Claim and Lease semantics

Each Claim is bound to one Task, Step, Assignment, Worker, and WorkerSession. A session may resume its current active Claim instead of creating a duplicate. Claiming increments the unit attempt counter.

Expired Claims become `EXPIRED`; their `CLAIMED` / `RUNNING` units return to `AVAILABLE`. Another web GPT session can then claim them. Retryable failures return to `AVAILABLE` until the unit attempt budget is exhausted; terminal failures become `FAILED` and can block the stage.

The intended image-production loop is therefore:

```text
claim U001-U010
  -> produce
  -> complete_and_claim_next
claim U011-U020
  -> ...
claim U091-U100
  -> STAGE_WORK_COMPLETE
```

The same model supports multiple workers. Five GPT sessions can each claim ten disjoint units; whichever finishes first can take the next available batch.

## Deployment boundary

The MCP HTTP process remains loopback-only by default and requires the existing bearer-token policy. The protocol implementation is therefore safe to develop and test locally without publishing an OpenAI directory app. Making the endpoint reachable from ChatGPT cloud (for example through a separately reviewed secure tunnel / HTTPS deployment) is a deployment step, not part of Worker scheduling semantics.