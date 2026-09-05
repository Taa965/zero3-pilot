# Zero3 Pilot Remote Host Runtime

## Status

H0 architecture contract for remote host execution.

## Goal

Allow an external commander such as a ChatGPT web session to submit a high-level development task through an AWS control plane and have a local Zero3 Pilot desktop execute that task in the real Windows workspace through the existing pinned open-source Codex core.

## Non-negotiable architecture

Open-source Codex remains the single authoritative Agent Kernel.

```text
External Commander
      |
      v
AWS Control Plane
      |
      v
Zero3 Remote Host Runtime
      |
      v
Zero3CodexAppServer
      |
      v
pinned `codex app-server --stdio`
      |
      v
real local workspace / shell / files / git / MCP
```

The Remote Host Runtime is transport, task-correlation, policy preflight and evidence collection infrastructure. It is not an agent loop.

## Forbidden target shapes

The following are architecture regressions:

```text
Remote Commander -> Hermes runtime -> custom agent loop -> shell
```

```text
Remote Commander -> Zero3 Node -> CodexWorker/ClaudeWorker/HermesWorker
```

```text
Remote Commander -> arbitrary command string -> direct shell execution
```

```text
Renderer -> generic Codex JSON-RPC proxy
```

Remote development work must enter the same Codex Thread / Turn / Item runtime used by the local desktop core.

## H0-H3 scope

The first implementation phase is intentionally narrow:

1. define a typed remote-task contract;
2. add a Zero3-owned Remote Host Runtime to the desktop Electron main process;
3. use outbound HTTPS long-polling to receive tasks from an AWS control plane;
4. validate the task and workspace before execution;
5. map one remote task to one Codex Thread;
6. map task execution to Codex Turns;
7. correlate Codex lifecycle/Item events with the remote task;
8. return terminal task evidence to the control plane.

H0-H3 does not add an independent planner, model runtime, or shell executor.

## Runtime authority

The authority order is:

1. Codex Thread / Turn / Item state is authoritative for agent execution.
2. The local Remote Host Runtime owns only remote-task correlation and delivery state.
3. AWS stores control-plane task/lease state and remote mirrors.
4. External commander state is never the source of truth for local execution.

## Remote-task lifecycle

```text
queued (AWS)
  -> leased
  -> accepted locally
  -> codex thread started/resumed
  -> codex turn started
  -> running
  -> terminal turn
  -> evidence uploaded
  -> succeeded / failed / blocked / outcome_unknown
```

A remote task must not be reported succeeded merely because an assistant message claims success. Terminal reporting must be tied to the authoritative Codex turn state and collected execution evidence.

## Security defaults

- Local host opens no inbound public port.
- The host initiates HTTPS connections to the configured control plane.
- Control-plane URL must be HTTPS outside explicit development mode.
- Credentials are read from a local file and must never be committed or rendered in logs.
- Workspaces are allow-listed locally.
- Remote tasks never receive a generic direct shell capability.
- Codex approval and sandbox rules remain authoritative.
- Remote tasks do not silently enable `danger-full-access`.
- Unsupported or ambiguous task envelopes fail closed.

## Task-to-Codex mapping

```text
RemoteTask.task_id     <-> local remote task record
RemoteTask             <-> one durable Codex Thread
initial execution      <-> first Codex Turn
continue/rework        <-> subsequent Codex Turns
Codex Items            <-> evidence events
```

The adapter must use named/typed app-server operations and must not expose arbitrary JSON-RPC methods to the Renderer.

## Initial transport

H2 uses outbound HTTPS long-polling. WebSocket may be added later without changing the task contract.

Expected control-plane host operations:

```text
POST /api/host/v1/nodes/register
POST /api/host/v1/nodes/{node_id}/heartbeat
POST /api/host/v1/tasks/lease
POST /api/host/v1/tasks/{task_id}/renew
POST /api/host/v1/tasks/{task_id}/events
POST /api/host/v1/tasks/{task_id}/complete
POST /api/host/v1/tasks/{task_id}/fail
POST /api/host/v1/tasks/{task_id}/blocked
```

The AWS implementation is outside this repository and may land independently.

## Desktop ownership

`apps/zero3-desktop` owns the local host integration because Electron main already owns `Zero3CodexAppServer` and the pinned Codex child process.

The target implementation should remain a thin Zero3-owned layer around that existing runtime rather than copying Codex behavior into Hermes or Zero3 Node.
