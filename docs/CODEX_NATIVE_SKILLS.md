# Codex Native Skills in Zero3 Pilot

## Authority

Zero3 Pilot uses the open-source Codex Skill system as the only Skill source of truth. Zero3 does not maintain a parallel `SkillRegistry`, package database, manifest copy, or installer.

```text
Codex Native Skills
        |
        +-- skills/list
        +-- skills/config/write
        +-- skills/changed
        +-- UserInput::Skill { name, path }
        +-- built-in skill-installer
        |
     Zero3 UI / adapters / Web Skill Gateway
```

Zero3's desktop Agent Kernel keeps its isolated `CODEX_HOME`. When that differs from the user's normal Codex home, Zero3 attaches `~/.codex/skills` as an app-server `skills/extraRoots/set` root. Both applications therefore read the same Skill files; Zero3 does not synchronize copies.

## Desktop surface

The Skills module lists native Codex metadata, searches it locally, refreshes on `skills/changed`, and toggles Skill state with `skills/config/write`.

The Install action starts a normal Codex Thread and invokes Codex's system `skill-installer` Skill. GitHub/private-repository behavior, credentials, download fallback, destination rules, and future installer improvements remain owned by Codex.

The installation request selects an enabled **system-scope** installer and explicitly instructs its native script to use `--dest` with the shared Skill root (`ZERO3_SHARED_CODEX_SKILLS_ROOT`, otherwise `~/.codex/skills`). The isolated kernel's `CODEX_HOME` is not the install destination.

The Skills page retains the live installation while switching modules, displays installer output, handles command/file approvals and native questions, and supports cancellation. Completion and failure refresh the catalog. A completed Codex Turn is labelled **installation task ended**, not installation success: the installer can report a repository, authentication, or existing-destination failure in a successful Turn. Users should inspect its report and the refreshed list. Live progress is scoped to the current desktop renderer; recovery of pending approvals after a full app restart is not implemented.

Regression validation: `node --test apps/zero3-desktop/tests/skill-install.test.cjs` (uses the prepared desktop's dependencies, or `ZERO3_TEST_NODE_MODULES`), plus `node scripts/check-codex-native-skills.mjs`. Tests exercise the actual overlay helpers, native RPC/event lifecycle, and rendered installation panel without installing a Skill in the user's home directory.

Native Skill execution uses the upstream structured input:

```json
{"type":"skill","name":"skill-name","path":".../SKILL.md"}
```

followed by the task text. Zero3 does not paste every `SKILL.md` into every session.

## Web GPT Skill Gateway

Web GPT sessions use a separate MCP authority from the existing Web Worker protocol:

```text
ChatGPT private app
  -> HTTPS /mcp/skills
  -> durable fenced RPC queue
  -> outbound local Zero3 long-poll
  -> pinned Codex app-server
  -> native Skill UserInput
```

`/mcp` remains the task/worker lifecycle surface and does not expose `invoke_skill`. `/mcp/skills` exposes only:

- `list_skills`
- `search_skills`
- `get_skill`
- `invoke_skill`

The Skill MCP endpoint uses `ZERO3_SKILL_MCP_TOKEN_FILE`, separate from `ZERO3_WORKER_MCP_TOKEN_FILE`. The AWS relay never executes Codex. For `get_skill`, it may transiently buffer a bounded response containing SKILL.md text inside the fenced RPC record; Skill RPC records expire and are removed, and AWS is never the Skill authority.

`list_skills` and `search_skills` return bounded metadata without local absolute Skill paths. `get_skill` returns at most 128 KiB from a path resolved from the live Codex catalog and omits that path from the response. `invoke_skill` requires a `cwd`; local Zero3 accepts it only when it exactly matches a `ZERO3_REMOTE_HOST_WORKSPACES` allow-listed workspace. The actual Skill path remains local and is resolved immediately before native Codex execution.

Invocation uses `approvalPolicy=on-request` and `sandbox=read-only`; a Skill cannot silently convert a web session into unrestricted local execution.

## Configuration

AWS / `zero3-web`:

```text
ZERO3_WORKER_GATEWAY_ENABLED=1
ZERO3_WORKER_GATEWAY_NODE_ID=<local Zero3 node id>
ZERO3_WORKER_GATEWAY_DATA_DIR=/var/lib/zero3-pilot/worker-gateway
ZERO3_SKILL_MCP_TOKEN_FILE=/etc/zero3-pilot/secrets/skill-mcp.token
```

The Worker MCP token is optional when only the Skills MCP surface is enabled; when both are used, configure two independent secrets.

Local Zero3 Pilot:

```text
ZERO3_SKILL_TUNNEL_ENABLED=1
ZERO3_WORKER_TUNNEL_BASE_URL=https://pilot.03.336r.com
ZERO3_WORKER_TUNNEL_TOKEN_FILE=<host token file>
ZERO3_WORKER_TUNNEL_NODE_ID=<same node id as AWS>
ZERO3_REMOTE_HOST_WORKSPACES=<allowed project path>[;<another path>]
```

The Skill tunnel deliberately reuses the authenticated durable host transport; it does not reuse the Worker tool authority.


Exact native/adapter support and deliberate non-support are recorded in [`CODEX_NATIVE_SKILLS_SUPPORT_MATRIX.md`](CODEX_NATIVE_SKILLS_SUPPORT_MATRIX.md).
