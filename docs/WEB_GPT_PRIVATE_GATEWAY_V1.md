# Zero3 Web-GPT Private Gateway V1

## Purpose

This phase connects a private ChatGPT MCP app to the existing local Zero3 Worker Protocol without giving the web session Codex, GPU, shell, filesystem, or workflow-administration authority.

The local Worker Runtime remains authoritative for Worker, Session, Claim, Lease, WorkUnit, progress, failure, and completion state. AWS stores only short-lived, durable RPC forwarding records.

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

The gateway exposes only six tools:

- `register_worker`
- `claim_work`
- `report_progress`
- `complete_and_claim_next`
- `report_failure`
- `get_task_context`

`/mcp` requires a dedicated bearer secret from `ZERO3_WORKER_MCP_TOKEN_FILE`. It accepts the supported 2025 Streamable HTTP protocol revisions, validates any supplied Origin against ChatGPT/OpenAI HTTPS origins, bounds request bodies to 2 MiB, and returns HTTP 405 for unsupported GET streaming rather than opening an SSE channel.

The MCP token is deliberately separate from the existing control token. The web session cannot select a destination node: `ZERO3_WORKER_GATEWAY_NODE_ID` pins every RPC to one configured Zero3 instance.

## Host transport

The local application reuses the existing Remote Host HTTPS client but runs Worker RPC polling in an independent loop. Worker traffic therefore does not depend on a Codex remote task being active or idle.

`ZERO3_WORKER_TUNNEL_ENABLED=1` enables only this Worker channel. `ZERO3_REMOTE_HOST_ENABLED` may remain disabled. The Worker channel can use `ZERO3_WORKER_TUNNEL_BASE_URL`, `ZERO3_WORKER_TUNNEL_TOKEN_FILE`, and `ZERO3_WORKER_TUNNEL_NODE_ID`; when omitted, the existing Remote Host base URL/token/node settings are reused.

## RPC safety and recovery

Each cloud forwarding record is `queued -> leased -> completed|failed|expired`. A lease carries a new `lease_id` and monotonically increasing `fencing_token`; an expired lease returns to the queue while the overall request TTL is still valid. Results from stale lease generations are rejected.

Write-oriented Worker calls keep the caller's `idempotencyKey`. A repeated MCP call with the same scoped key and identical arguments reuses the same cloud RPC record. If local execution succeeds but result publication fails, the host does not manufacture a failure; the RPC is safely replayed after lease recovery and the local Worker Runtime's idempotency protection returns the original outcome.

The AWS process never imports or calls Codex, GPU, shell, filesystem, or generic desktop RPC APIs. Its only host-side operations are lease, complete, and fail for a bounded Worker RPC.

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
