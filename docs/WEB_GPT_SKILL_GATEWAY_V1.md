# Web GPT Codex Native Skill Gateway V1

This gateway lets an explicitly connected ChatGPT web session discover and invoke Skills owned by the local Codex Agent Kernel without moving Skill authority to AWS or to the browser.

The public endpoint is `POST /mcp/skills`. It has its own bearer token (`ZERO3_SKILL_MCP_TOKEN_FILE`) and exposes exactly `list_skills`, `search_skills`, `get_skill`, and `invoke_skill`.

The existing `POST /mcp` Worker Gateway is unchanged in authority: it still exposes task/worker lifecycle tools only. The two MCP catalogs are intentionally separate even though their messages share the same durable, fenced RPC queue and outbound host long-poll transport.

Security requirements:

1. AWS never executes Codex and is never a Skill authority. A bounded `get_skill` response may exist transiently in the durable RPC queue until its short expiry.
2. list/search/get responses omit local absolute Skill paths.
3. invocation requires an allow-listed project `cwd`.
4. local execution uses Codex native `UserInput::Skill` with `approvalPolicy=on-request` and `sandbox=read-only`.
5. worker and Skill MCP bearer secrets are independent.
6. stale lease/fencing generations remain rejected by the shared durable RPC transport.

See [`CODEX_NATIVE_SKILLS.md`](CODEX_NATIVE_SKILLS.md) for the desktop and Codex authority model.
