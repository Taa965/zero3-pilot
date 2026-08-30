# R4B ACP / Claude External Executor Boundary

Status: **AUDIT_READY / IMPLEMENTATION_BLOCKED**

This directory is the pre-freeze audit area for Zero3 Pilot Session A (R4B ACP / Claude External Executor). It must remain audit-only until Session 0 publishes `BASELINE FREEZE` after D2 and R4A are merged.

The current audit branch is intentionally not the final implementation branch required by the execution plan. After freeze, Session A must rebuild from the frozen `main_sha` as:

```text
feat/r4b-acp-runtime
```

## Current observed repository state

- Audit branch: `feat/r4b-acp-executors`
- Audit branch original base: `main@9f11c6e8c88283dbcaf8cc51e6a6fb35c5f25f7f`
- Current observed `main`: `32faf5e70076fc67035c8229729de035bd3a7f2a`
- D2 / PR #31 candidate head: `fd92a3fde463ecea04bb22c3a25b750fbf3deaa6`
- R4A / PR #44 current candidate head: `c786a591e140de403db3b0c885bf3af0305a3669`
- R4A PR current base: D2 candidate head `fd92a3fde463ecea04bb22c3a25b750fbf3deaa6`
- Frozen contract SHA: **not issued**
- `BASELINE FREEZE`: **not issued**

Therefore formal R4B runtime implementation remains blocked.

## Authority boundary

Open-source Codex remains the single Native Agent Kernel. ACP is an **External Executor transport boundary** only.

All ACP/acpx/provider-specific types and behavior must remain below:

```text
apps/zero3-desktop/executor-runtime/acp/
```

This boundary must not introduce:

- a second generic agent loop;
- a direct shell execution authority;
- Router/failover policy inside provider code;
- Handoff persistence or workspace authority;
- Native Codex replacement semantics;
- generic Renderer ACP/Codex RPC;
- approval bypass or implicit auto-approve;
- silent `session/new` after resume/context loss;
- runtime dependency resolution through `@latest`, semver ranges, or default `npx -y latest` behavior.

## Audited dependency candidates

Exact candidates are stored in `compatibility-pins.json` and must be revalidated again at freeze.

Current audit candidates:

- `@agentclientprotocol/sdk@1.4.0` — ACP v1 stable entry point; ACP v2 remains experimental.
- `acpx@0.13.2` — headless ACP runtime; Node 22.13+ floor.
- `@agentclientprotocol/claude-agent-acp@0.70.0` — Claude Code external adapter candidate.
- `@agentclientprotocol/codex-acp@1.7.0` — optional external Codex compatibility adapter only; never the Native Codex kernel path.

Zero3 Pilot must launch exact, locally installed adapter executables. Upstream convenience registries that resolve semver ranges or invoke `npx` dynamically are not acceptable for production R4B.

## R4A candidate compatibility review

The current, still-unfrozen R4A candidate now satisfies the two producer-contract gaps identified by the earlier audit:

1. **Permission response path resolved.** `Zero3Executor` now exposes `respondPermission(session, response)` and defines `ExecutorPermissionResponse` / `ExecutorPermissionDecision`.
2. **Unsupported failure mapping resolved.** `ExecutorFailureCode` now includes `unsupported`.

The candidate also exposes the R4B lifecycle surface needed for an adapter:

```text
probe
start
resume
prompt
respondPermission
cancel
close
```

and provides the required external-agent kind, typed events, typed failures, task/execution identity, policy context, generation and handoff checkpoint reference.

No `INTERFACE CHANGE REQUEST` is currently required by Session A based on this candidate contract. This conclusion is provisional until the exact frozen contract SHA is issued.

## Target implementation after BASELINE FREEZE

```text
Zero3 Executor Contract
        |
        v
R4B ACP Boundary
  - initialize/version negotiation
  - session new/load/resume
  - prompt/update projection
  - cancellation
  - permission bridge
  - typed failure normalization
  - process lifecycle guard
  - continuity guard
        |
        v
acpx/runtime (exact pin)
        |
        +-- claude-agent-acp (exact local executable)
        +-- codex-acp (optional compatibility executor only)
```

## Required behavior

### Initialization / protocol negotiation

- Target ACP v1 only.
- Accept only explicitly supported negotiated versions/capabilities.
- Unsupported protocol/capability must map to frozen `unsupported` failure semantics.
- Provider metadata remains diagnostic/untrusted and never grants execution authority.

### Session continuity

- Persistent work must preserve the same logical ACP session when resume/load is expected.
- Resume/load failure, missing backend session, adapter restart with lost context, or identity mismatch must become typed `context_lost`.
- `context_lost` must be escalated upward for Zero3 Pilot Handoff.
- R4B must never hide lost context by silently calling `session/new`.

### Prompt / event projection

- Convert `ExecutorInput` into ACP prompt input below the boundary.
- Normalize ACP messages, reasoning, plan/tool updates, file-change signals, permission requests, usage, failures and terminal completion into frozen `ExecutorEvent` values.
- ACP/acpx/Claude-specific types must not leak outside `acp/**`.

### Permission bridge

- Every ACP permission request must surface as a Zero3 Pilot permission request.
- Decisions return only through the frozen `respondPermission` contract path.
- Missing, malformed, unavailable or timed-out decisions fail closed.
- No non-interactive auto-approval.

### Cancellation / process failure

- `cancel` must reach the active ACP session/turn.
- Adapter process crash / broken stdio must normalize to the frozen failure taxonomy.
- Cancellation must not be disguised as retryable provider failure.

### Failure normalization

R4B fixtures must cover at least:

```text
quota_exhausted
rate_limited
auth_required
provider_overloaded
context_exhausted
budget_exhausted
permission_denied
policy_denied
transport_lost
process_crash
context_lost
unsupported
internal_error
```

Provider-specific details may be retained for diagnostics, but failover policy remains Zero3 Pilot-owned and outside this Session.

## Required implementation ownership after freeze

Allowed paths must be explicitly confirmed by Session 0, expected as:

```text
apps/zero3-desktop/executor-runtime/acp/**
tests/executor-runtime/acp/**
.github/workflows/r4b-acp-executor.yml
scripts/check-r4b-acp-architecture.mjs
```

Forbidden shared/runtime paths include Executor Contract / Manager / Router, Native Codex, Handoff, Remote Host, apps/web, codex-overlays, upstream and generic Renderer IPC unless Session 0 explicitly lands an approved shared change.

## Mandatory gates before R4B can leave draft

```text
ACP initialize                 PASS
Claude adapter probe           PASS
prompt/update                  PASS
cancel                         PASS
permission deny                PASS
permission unavailable         FAIL CLOSED
quota fixture                  PASS
rate-limit fixture             PASS
auth fixture                   PASS
adapter process crash          PASS
resume context-loss            PASS
no silent session/new          PASS
Windows spawn/path             PASS
type-leak architecture guard  PASS
```

Plus:

- `git diff --check`
- lint/typecheck
- exact-pin/no-runtime-range-launch guard
- no secret/hardcoded-host regression
- no approval bypass fixture
- protocol negotiation tests
- subprocess crash/restart tests

## Stop / ICR conditions

If the frozen contract lacks a capability required to implement the above, Session A must not edit shared files. Submit an `INTERFACE CHANGE REQUEST` to Session 0 and continue only unblocked work.

## Next action

Wait for Session 0 to publish:

```text
BASELINE FREEZE
project: Zero3 Pilot
main_sha: <merged-main-sha>
contract: zero3.pilot.executor.v1
contract_sha: <sha-containing-frozen-contract>
allowed_paths: <Session A ownership>
forbidden_paths: <shared and other-session ownership>
```

Then:

1. create/rebuild `feat/r4b-acp-runtime` from the exact frozen `main_sha`;
2. re-read the exact frozen contract;
3. revalidate dependency pins;
4. implement only Session A-owned paths;
5. run the full R4B gates;
6. open a clean PR and do not merge it.
