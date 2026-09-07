# ChatGPT Web MCP gate — 2026-09-08

Status: **write path locked; end-to-end account test still required**.

The HTTP transport is implemented as a loopback-only Streamable HTTP endpoint with bearer authentication, per-project egress allowlisting, audit logging, and a narrow outbound memory filter. `project_get_context` is always the only web tool registered by default.

The code registers `project_put_context` only when the process starts with:

```text
ZERO3_MCP_HTTP_WRITE_VERIFIED=1
```

Do not set that flag on the basis of subscription marketing or secondary reports. It is the construction gate representing phase 3.0 of the project plan: connect the actual account/workspace to this MCP endpoint in ChatGPT Developer Mode and prove a write tool call succeeds. If the write call is blocked, leave the flag unset; the read-only architecture remains valid.

As of the implementation date, current OpenAI Help Center wording no longer supports assuming full custom-MCP write capability on Pro: it describes full MCP write/modify rollout for Business, Enterprise, and Edu. That makes the hands-on gate more important, not less.

Security invariants:

- server binds `127.0.0.1` unless explicitly overridden;
- tunnel URLs are never treated as credentials;
- bearer token is 256 bits and stored mode `0600`;
- every request re-reads the token, so rotation invalidates the old token immediately;
- web access is off for every project until explicitly enabled;
- outbound project memory includes only `decisions`, `pitfalls`, and `glossary`;
- web writes, when verified and enabled, can change only those same fields and preserve local-only fields;
- public tunnel Host values must be explicitly configured in `ZERO3_MCP_HTTP_ALLOWED_HOSTS` (or rewritten to the loopback Host by the tunnel);
- absent Origin is accepted for server-to-server clients; browser Origins are restricted to OpenAI/ChatGPT domains plus explicit overrides.
