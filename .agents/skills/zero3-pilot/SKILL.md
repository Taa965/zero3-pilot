---
name: zero3-pilot
description: Use the local Zero3 Pilot Node for persistent jobs, automation, memory, Codex/Claude/Hermes dispatch, browser CDP, and computer control from inside the native Codex desktop workspace.
---

# Zero3 Pilot

Use this skill when the user asks to operate Zero3, run a Zero3 Agent, inspect persistent jobs, create or inspect automations, use Zero3 memory, drive the isolated browser, or use the Zero3 computer-control adapter.

## Architecture

Codex Desktop is the primary visible shell. Do not recreate a separate desktop UI. Zero3 runs as a loopback-only sidecar at `http://127.0.0.1:8790` by default. The diagnostic dashboard may still exist, but prefer native Codex conversation/project/terminal/diff/permission UX and call the sidecar only for Zero3-specific capabilities.

If `ZERO3_PILOT_NODE_PORT` is explicitly known in the current shell, use that port instead of `8790`.

## Health and read operations

Before a Zero3 operation, check the Node when needed:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health
```

Useful read-only endpoints:

```text
GET /api/v1/status
GET /api/v1/jobs
GET /api/v1/jobs/{id}
GET /api/v1/schedules
GET /api/v1/memory
```

Use `Invoke-RestMethod` from PowerShell for local calls. Keep all Zero3 Node traffic on loopback.

## Mutating operations

Only perform a mutation when the user's current request clearly asks for it. Never turn an inferred intention into `approved: true`.

The main job submission endpoints are:

```text
POST /api/v1/jobs/agent
POST /api/v1/jobs/browser
POST /api/v1/jobs/computer
```

Agent example after explicit user approval/request:

```powershell
$body = @{
  backend = 'codex'
  goal = 'Inspect the current project and report blocking issues'
  context = @{}
  granted_level = 'Standard'
  approved = $true
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body http://127.0.0.1:8790/api/v1/jobs/agent
```

The endpoint returns a `job_id`; poll `GET /api/v1/jobs/{id}` rather than creating duplicate jobs.

Browser and computer payload schemas evolve with the providers. Before constructing an unfamiliar write payload, inspect `apps/node/src/main.rs`, provider action enums, or `apps/node/static/index.html` in this repository rather than guessing field names.

## Safety and permissions

- Read-only status/list/query operations can run without extra confirmation when they directly answer the user's request.
- Browser navigation/session changes are Zero3 side effects. Browser click/type/evaluate and computer click/type/key actions are higher-impact writes; require explicit current-turn user intent and honor the Node policy result.
- Do not bypass `403` or `428` policy responses. Explain the required approval instead.
- Do not send Zero3 data to non-loopback services unless the user explicitly requested the external action.
- Reuse existing persistent jobs/schedules when appropriate; do not create duplicates simply because a previous poll timed out.

## Product direction

When changing this repository, preserve this boundary:

```text
Codex native desktop shell
        |
        +-- Zero3 workspace skill/plugin layer
        |
        +-- Zero3 Pilot Node (127.0.0.1)
              +-- jobs / scheduler / memory
              +-- Codex / Claude / Hermes adapters
              +-- browser CDP
              +-- computer use
```

Do not reintroduce Tao/Wry as the primary product shell unless the user explicitly reverses the architecture decision.
