# Zero3 Pilot R4C — Native Codex auth/provider POC

This directory is owned by session 4 for the R4C Native Codex / API workstream.
It deliberately does **not** define the shared Executor Contract. R4A is owned
by session 2 and must be frozen before this POC becomes the formal
`NativeCodexExecutor` adapter.

## Pinned upstream evidence

Zero3 Pilot pins open-source Codex at:

`94311d447587411789533c47601fd8bc9d81eb48`

At that pin, Codex itself establishes the seams R4C needs:

- Codex state defaults to `~/.codex` and can be redirected with `CODEX_HOME`.
- app-server `initialize` returns the effective `codexHome`.
- `account/read` reports the current auth account without requiring callers to
  read credential files.
- managed ChatGPT auth (`account.type === "chatgpt"`) is the subscription path;
  Codex owns refresh-token persistence and refresh.
- `account/rateLimits/read` and `account/rateLimits/updated` expose typed ChatGPT
  quota state, including `rateLimitReachedType`.
- `modelProvider/capabilities/read` and explicit `modelProvider` request fields
  provide the provider-override seam.

## Current Zero3 Pilot mismatch

The current desktop launcher intentionally replaces `CODEX_HOME` with a
Zero3-Pilot-specific isolated directory. That prevents an already logged-in
host `~/.codex` from being seen by the pinned app-server even though upstream
Codex natively supports it.

R4C Wave 0 therefore proves reuse without changing the launcher:

1. resolve the host subscription home (`~/.codex` by default, or an explicit
   `ZERO3_NATIVE_CODEX_HOME`),
2. start the **pinned** Codex app-server against that home,
3. call `account/read`,
4. for ChatGPT auth, call `account/rateLimits/read`,
5. probe `modelProvider/capabilities/read`,
6. emit only sanitized state.

The probe never opens `auth.json`, never serializes access/refresh tokens, and
never writes credentials into a Zero3 Pilot database.

## Security invariants

- Pinned Codex remains the Native Agent Kernel.
- Zero3 Pilot does not implement OAuth token handling.
- No credential copying/export is allowed.
- Auth state is learned only through typed app-server RPCs.
- The probe is non-interactive and fails closed on server-originated requests.
- API-key auth is **not** mislabeled as reusable ChatGPT subscription auth.
- Approval/sandbox/tool semantics remain upstream Codex semantics.

## Wave 0 tests

Run directly without changing shared package scripts:

```bash
node --test apps/zero3-desktop/executor-runtime/native/*.test.mjs
```

## Integration dependency / interface-change request

Turning this POC into the production Native executor requires two upstream
coordination points:

1. R4A Executor Contract SHA from session 2.
2. A launcher/app-server construction seam that can select the host Codex home
   for the Native subscription executor without making every other Codex usage
   implicitly share credentials.

Session 4 must not modify the shared launcher or `Zero3CodexAppServer` public
surface until the integration controller assigns that interface change.
