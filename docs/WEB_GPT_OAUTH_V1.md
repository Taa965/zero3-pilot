# Zero3 Web GPT OAuth V1

## Purpose

Zero3 exposes a private Streamable HTTP MCP endpoint at `/mcp`. OAuth V1 adds an OAuth 2.1-style authorization-code flow with S256 PKCE for ChatGPT custom apps while preserving the existing static Worker MCP bearer token as an internal compatibility path.

OAuth does not change Worker Protocol authority. The public surface still exposes only the bounded Worker/Lifecycle tool catalog; Codex dispatch, GPU control, shell execution, filesystem administration and Workflow topology administration remain unavailable through MCP.

## Discovery

The server exposes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`
- `/authorize`
- `/token`
- `/revoke`

Unauthorized `/mcp` responses advertise the protected-resource metadata URL in `WWW-Authenticate`.
## Security model

ChatGPT registers as a public OAuth client. Only `authorization_code` and `refresh_token` grants are accepted, and authorization requires S256 PKCE. The interactive authorization page additionally requires the dedicated Zero3 OAuth Owner Secret.

The Owner Secret is normally read from `ZERO3_WORKER_OAUTH_OWNER_SECRET_FILE`; production deployments should keep it separate from Host, Control and Worker MCP tokens. For backward-compatible bootstrap only, if the dedicated owner-secret variable is unset, the runtime falls back to the configured Worker MCP token file. OAuth access tokens, refresh tokens and authorization codes are never stored in plaintext. Their SHA-256 hashes and scoped metadata are persisted under the Worker Gateway data directory.

Access tokens expire after one hour. Refresh tokens expire after 30 days and rotate on use. `offline_access` is advertised and produces a refresh token so ChatGPT can maintain connectivity without repeatedly asking the owner to authorize.

Dynamic client registration accepts HTTPS redirect URIs. Redirect URIs are matched exactly during authorization-code exchange. Authorization codes are single-use and expire after five minutes.

## Configuration

```text
ZERO3_WORKER_OAUTH_ENABLED=1
ZERO3_WORKER_OAUTH_ISSUER=https://pilot.example.com
ZERO3_WORKER_OAUTH_OWNER_SECRET_FILE=/etc/zero3-pilot/secrets/worker-oauth-owner.secret
```

`ZERO3_WORKER_MCP_TOKEN_FILE` may remain configured for server-side compatibility and smoke tests. ChatGPT should use OAuth after OAuth V1 is enabled.
