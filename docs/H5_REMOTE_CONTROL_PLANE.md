# Zero3 Pilot Remote Host H5 — Durable AWS Control Plane

## Purpose

H5 turns the existing Zero3 Pilot `apps/web` service into the durable control-plane counterpart of the Windows Remote Host introduced in H0–H4.

The control plane owns remote task admission, node presence, leases, fencing, accepted remote mirrors and terminal task state. It does **not** execute development work. Codex Thread / Turn / Item state on the Windows host remains the sole development execution authority.

## Runtime boundary

```text
Commander / future ChatGPT-facing bridge
        |
        |  control token
        v
Zero3 Pilot apps/web on AWS
        |
        |  durable task/node state
        |  lease + fencing authority
        v
/api/host/v1/*
        |
        |  host token + x-zero3-node-id
        v
Windows Zero3 Remote Host
        |
        v
Zero3CodexAppServer
        |
        v
pinned open-source Codex
```

No AWS handler gains shell, Git, filesystem, MCP or generic Codex RPC authority.

## Authentication

Two independent bearer secrets are read from files at process startup:

- `ZERO3_HOST_TOKEN_FILE` — authorizes `/api/host/v1/*` Remote Host traffic.
- `ZERO3_CONTROL_TOKEN_FILE` — authorizes `/api/control/v1/*` task/query traffic.

The files must be configured together. When neither is configured, `/health` remains available but remote-control endpoints fail closed with HTTP 503.

Secrets are never written into durable task/node state.

## Persistence

State defaults to:

```text
/var/lib/zero3-pilot/control-plane/
  tasks/<task_id>.json
  nodes/<node_id>.json
```

The root can be overridden with `ZERO3_CONTROL_PLANE_DATA_DIR`.

Each task/node mutation is persisted independently using:

```text
serialize complete record
  -> create private temporary file
  -> write
  -> fsync file
  -> atomic rename to committed record
  -> fsync parent directory on Unix
```

Committed JSON corruption is fatal at startup. Temporary files are not loaded as committed state.

The existing systemd unit already grants the isolated `zero3pilot` service account write access to `/var/lib/zero3-pilot`.

## Task identity

H5 accepts only protocol:

```text
zero3.pilot.remote-task.v1
```

`task_id` is globally bound to one exact task payload and one `execution_id`. Re-submitting the exact task is idempotent. Reusing either identity with different content fails closed with HTTP 409.

This matches the Pilot-side durable task-to-Codex mapping contract and avoids silently turning one logical task identity into a new execution.

## Lease and fencing authority

A task begins `queued`.

On first lease:

1. the requesting node must already be registered;
2. required capabilities include `codex`, `thread`, and `turn`;
3. the task becomes sticky to that node;
4. the control plane allocates a new `lease_id`;
5. the task fencing token increments;
6. lease expiry is persisted before the lease is returned.

Lease renewal persists a new expiry before acknowledging the host.

### Sticky recovery invariant

An expired task is **not automatically reassigned to another node**. Only the original sticky node may acquire a new lease/fencing generation for that task.

This is intentional. During a network partition the original Windows host may still have a real Codex Turn running. Reassigning the same task/execution to another machine would create a cross-host duplicate-execution window. A permanently lost host must therefore be handled by an explicit future control-plane recovery/requeue operation with new execution identity rather than implicit failover.

## Fencing

Every accepted event or terminal outcome must match the task's current:

```text
execution_id
node_id
lease_id
fencing_token
unexpired lease
```

Stale/expired leases return HTTP 410. Stale fencing returns HTTP 412. Those status codes intentionally match the Windows H4 quarantine semantics.

## Durable delivery identity

H4 sends a stable `delivery_id` for every event and terminal outcome. H5 stores a canonical fingerprint for each accepted delivery.

- same `delivery_id` + same content => idempotent success, even after the task later becomes terminal;
- same `delivery_id` + different content => HTTP 409;
- unknown new delivery after a task is terminal => HTTP 409.

This allows a Windows outbox replay to safely acknowledge an envelope that the server accepted before either side restarted.

## Event sequence

`event_sequence` must be strictly greater than the last accepted sequence, but it does **not** need to be contiguous.

Gaps are allowed because an older lease generation can be fenced out and its still-pending envelopes quarantined locally. The next valid lease generation must be able to continue with its durable per-task/execution sequence without being permanently blocked by those intentionally rejected envelopes.

A repeated/lower sequence under a new delivery identity fails closed with HTTP 422.

## Terminal routes

- `/complete` accepts only `succeeded`.
- `/blocked` accepts only `blocked`.
- `/fail` accepts `failed`, `cancelled`, `outcome_unknown`, or `quarantined`.

An accepted terminal record is durable before the API acknowledges it and clears the active lease.

## H5 API

Host side:

```text
POST /api/host/v1/nodes/register
POST /api/host/v1/nodes/:node_id/heartbeat
POST /api/host/v1/tasks/lease
POST /api/host/v1/tasks/:task_id/renew
POST /api/host/v1/tasks/:task_id/events
POST /api/host/v1/tasks/:task_id/complete
POST /api/host/v1/tasks/:task_id/fail
POST /api/host/v1/tasks/:task_id/blocked
```

Control side:

```text
POST /api/control/v1/tasks
GET  /api/control/v1/tasks
GET  /api/control/v1/tasks/:task_id
GET  /api/control/v1/nodes
```

The control API is deliberately narrow. It cannot call Codex, shell commands, Git, filesystem operations or desktop IPC.

## Non-goals

H5 does not add:

- direct ChatGPT MCP exposure;
- arbitrary command transport;
- cross-node automatic failover;
- task cancellation/interrupt;
- destructive administrative recovery;
- a second planner/model/agent loop;
- a second durable execution history competing with Codex.

Those require separate reviewed phases after the AWS↔Windows protocol is proven end to end.
