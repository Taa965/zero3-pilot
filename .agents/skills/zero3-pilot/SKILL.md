---
name: zero3-pilot
description: Use the local Zero3 Pilot Node for persistent jobs, automation, memory, Codex/Claude/Hermes dispatch, browser CDP, and computer control from Zero3 Desktop or a compatible agent shell.
---

# Zero3 Pilot

Use this skill when the user asks to operate Zero3, run a Zero3 Agent, inspect persistent jobs, create or inspect automations, use Zero3 memory, drive the isolated browser, or use the Zero3 computer-control adapter.

## Architecture

Zero3 Pilot Node is the local control plane and remains loopback-only at `http://127.0.0.1:8790` by default. The desktop migration uses the pinned open-source Hermes Desktop Electron/React shell as the primary GUI foundation. Codex and DeepSeek are execution engines/adapters, not the owner of the Zero3 UI.

Do not call the proprietary Codex Desktop/AppX and present it as Zero3's own UI. The pinned `upstream/codex` source is used for open-source Codex CLI/app-server integration. The pinned `upstream/deepseek-harness` source is an additional adapter/UI architecture reference. Hermes Desktop may host the conversation surface during migration, while Zero3-specific actions continue through the Zero3 Node policy boundary.

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

Use the local shell's HTTP client (`Invoke-RestMethod`, `curl`, or equivalent) for loopback calls. Keep all Zero3 Node traffic on loopback unless the user explicitly requests an external action.

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
Zero3 Desktop
  Hermes Desktop Electron/React shell (open-source upstream)
        |
        +-- Zero3 skill / future native transport adapter
        |
        +-- Zero3 Pilot Node (127.0.0.1)
              +-- jobs / scheduler / memory
              +-- Codex app-server / CLI adapter
              +-- Claude adapter
              +-- Hermes adapter
              +-- DeepSeek Harness adapter
              +-- browser CDP
              +-- computer use
```

The migration is staged. Phase A may still use Hermes' own headless runtime for chat transport while Zero3 actions are provided through this skill and the local Node. Phase B replaces that compatibility bridge with a direct Zero3 desktop transport so the UI is fully owned by Zero3 without losing the Hermes-derived shell architecture.

Do not reintroduce Tao/Wry as the primary product shell and do not invest in Codex TUI as the final desktop GUI unless the user explicitly reverses this architecture decision.
