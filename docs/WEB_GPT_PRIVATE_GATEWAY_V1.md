# Zero3 Web-GPT Private Gateway V1

## Purpose

This phase connects a private ChatGPT MCP app to the existing local Zero3 Worker Protocol without giving the web session direct Codex RPC, GPU, shell, filesystem, generic desktop, or workflow-administration authority. Fast Path P0 additionally exposes a bounded typed Codex task-dispatch operation through the existing Control Plane; it is not a general Codex executor surface.

The local Zero3 runtimes remain authoritative: Worker Runtime owns V1 WorkUnit/Claim state, Execution Runtime owns Task/Step/Assignment state, Shared Memory owns organizational memory/decisions, and Artifact Runtime owns asset metadata. AWS stores only short-lived, durable RPC forwarding records.

```text
ChatGPT private app
        |
        | HTTPS Streamable HTTP MCP
        v
pilot.03.336r.com/mcp
        |
        | durable Worker RPC queue
        v
Zero3 Pilot AWS control plane
        ^
        | outbound authenticated HTTPS long-poll
        |
local Zero3 Pilot
        |
        v
local Worker Runtime (SQLite)
```

## Public MCP surface

The gateway exposes only bounded Worker/Agent lifecycle tools. V1 compatibility remains:

- `register_worker`
- `claim_work`
- `report_progress`
- `complete_and_claim_next`
- `report_failure`
- `get_task_context`

Shared organizational lifecycle adds:

- `session_start`
- `context_resolve`
- `task_claim`
- `event_record`
- `artifact_register`
- `task_complete`
- `memory_commit`
- `handoff_create`

Fast Path P0 adds bounded composites for the common development path:

- `task_bootstrap` — session start/resume + GPT_WEB claim + filtered context/handoff resolve in one call.
- `dispatch_codex_task` — typed high-level Remote Host/Codex task submission for an allow-listed workspace.
- `dispatch_agent_task` — unified task submission: Web GPT submits a typed objective and the Zero3
  Intelligent Agent Task Router decides whether Codex, Claude, Gemini or the Zero3 API executes it. It
  accepts `routingMode` (`AUTO`/`PINNED`/`PREFERRED`), an optional `preferredExecutor`, `taskType`,
  `importance`, constraints and acceptance criteria — never a command, shell string, executable or
  credential. The response carries the routing decision, attempt chain and the executor's structured
  result under one unchanged Task identity.
- `verify_commit` — fixed static checks + explicit task-owned path staging + one scoped commit/push.

Workflow Worker v2 lifecycle also exposes `bootstrap_worker`, `commit_and_claim_next`, `report_blocked`, and `recover_worker`. See `WEB_GPT_FAST_PATH_P0.md` for the P0 retry, security, batching and timing policy.

`/mcp` requires a dedicated bearer secret from `ZERO3_WORKER_MCP_TOKEN_FILE`. It accepts the supported 2025 Streamable HTTP protocol revisions, validates any supplied Origin against ChatGPT/OpenAI HTTPS origins, bounds request bodies to 2 MiB, and returns HTTP 405 for unsupported GET streaming rather than opening an SSE channel.

The MCP token is deliberately separate from the existing control token. The web session cannot select a destination node: `ZERO3_WORKER_GATEWAY_NODE_ID` pins every RPC to one configured Zero3 instance.

## Host transport

The local application reuses the existing Remote Host HTTPS client but runs Worker RPC polling in an independent loop. Worker traffic therefore does not depend on a Codex remote task being active or idle.

`ZERO3_WORKER_TUNNEL_ENABLED=1` enables only this Worker channel. `ZERO3_REMOTE_HOST_ENABLED` may remain disabled. The Worker channel can use `ZERO3_WORKER_TUNNEL_BASE_URL`, `ZERO3_WORKER_TUNNEL_TOKEN_FILE`, and `ZERO3_WORKER_TUNNEL_NODE_ID`; when omitted, the existing Remote Host base URL/token/node settings are reused.

## RPC safety and recovery

Each cloud forwarding record is `queued -> leased -> completed|failed|expired`. A lease carries a new `lease_id` and monotonically increasing `fencing_token`; an expired lease returns to the queue while the overall request TTL is still valid. Results from stale lease generations are rejected.

Write-oriented Worker calls keep the caller's `idempotencyKey`. A repeated MCP call with the same scoped key and identical arguments reuses the same cloud RPC record. If local execution succeeds but result publication fails, the host does not manufacture a failure; the RPC is safely replayed after lease recovery and the local Worker Runtime's idempotency protection returns the original outcome.

The AWS Worker Gateway process never imports or directly calls Codex, GPU, shell, filesystem, Google Drive credentials, or generic desktop RPC APIs. Its host-side role remains lease, complete, and fail for bounded Worker/Lifecycle/Fast-Path RPC. `dispatch_codex_task` is validated and translated only on the authorized local Zero3 host, then submitted through the existing typed Control Plane. Lifecycle tool execution remains inside the local Zero3 Task/Memory/Artifact authority boundary.

## Configuration

AWS `zero3-web`:

```text
ZERO3_WORKER_GATEWAY_ENABLED=1
ZERO3_WORKER_GATEWAY_NODE_ID=<local Zero3 node id>
ZERO3_WORKER_GATEWAY_DATA_DIR=/var/lib/zero3-pilot/worker-gateway
ZERO3_WORKER_MCP_TOKEN_FILE=/etc/zero3-pilot/secrets/worker-mcp.token
```

Local Zero3 Pilot:

```text
ZERO3_WORKER_TUNNEL_ENABLED=1
ZERO3_WORKER_TUNNEL_BASE_URL=https://pilot.03.336r.com
ZERO3_WORKER_TUNNEL_TOKEN_FILE=<host token file>
ZERO3_WORKER_TUNNEL_NODE_ID=<same node id as AWS>
```
