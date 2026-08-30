# R4B ACP / External Executor Boundary

Status: **AUDIT_READY / IMPLEMENTATION_BLOCKED**

This directory is owned by Zero3 Pilot Session 3. The current commit is deliberately audit-only: it does not define shared Executor Contract types, does not implement Router policy, and does not make ACP an alternative Agent Kernel.

## Baseline

- Session branch: `feat/r4b-acp-executors`
- Audit base: `main@9f11c6e8c88283dbcaf8cc51e6a6fb35c5f25f7f`
- Required upstream dependency: frozen R4A Executor Contract SHA
- Current blocker: `feat/r4a-executor-contract` still points at the audit base and no `BASELINE FREEZE` contract SHA has been issued.

Formal R4B implementation must not begin until the integration controller freezes the R4A contract and allowed/forbidden paths.

## Architecture boundary

Open-source Codex remains the single Native Agent Kernel. ACP is an **External Executor transport boundary** only.

All ACP/acpx types and behavior must remain below:

```text
apps/zero3-desktop/executor-runtime/acp/
```

No ACP/acpx type may leak into the Zero3-owned Executor Contract, Router, Handoff contract, Renderer IPC, or Remote Host contract.

This boundary must never introduce:

- a second generic agent loop;
- a direct remote shell executor;
- a generic Renderer ACP/Codex RPC proxy;
- automatic approval bypass;
- implicit context replacement after failed resume;
- runtime package resolution through `@latest` or semver ranges.

## Audited upstream compatibility candidates

The exact audit candidates are recorded in `compatibility-pins.json` and must be revalidated at the implementation freeze.

Current audit findings:

1. `@agentclientprotocol/sdk` exposes ACP v1 from its stable entry point; ACP v2 remains experimental. R4B targets ACP v1 only.
2. `acpx` exposes a headless runtime API with `ensureSession`, `startTurn`, `cancel`, status/capability controls, permission callbacks, and persistent session state.
3. Current `acpx` maps persistent sessions to a `same-session-only` resume policy. Zero3 Pilot will still enforce an independent postcondition: a persistent resume that cannot prove continuity becomes typed context loss / handoff-required; it must never silently become a new session.
4. `acpx` built-in Codex/Claude registry entries use `npx` plus semver ranges. Zero3 Pilot must not use those defaults. R4B must override agent launch resolution to locally installed, exact-version executable paths and fail closed if the exact adapter is unavailable.
5. `@agentclientprotocol/codex-acp` is an optional compatibility external executor only. It must not replace or redefine the Native Codex path owned by Session 4.
6. `@agentclientprotocol/claude-agent-acp` remains an optional external executor. Its Claude Agent SDK dependency stays encapsulated behind the adapter package; Zero3 Pilot core must not vendor Claude SDK types or runtime behavior.
7. The pinned Hermes desktop shell requires Node 22.22+ (or its declared alternatives), which satisfies the audited `acpx` Node 22.13+ floor.

## Target implementation after R4A freeze

The implementation should remain narrow and layered:

```text
Zero3 Executor Contract
        |
        v
ACP boundary adapter
  - capability/version negotiation
  - session continuity guard
  - prompt/update projection
  - cancellation
  - permission bridge
  - typed failure normalization
        |
        v
acpx runtime (exact pin)
        |
        +-- claude-agent-acp (exact local executable)
        +-- codex-acp (optional compatibility executor, exact local executable)
```

The boundary must map only to the frozen Zero3-owned contract. It must not import Router fallback policy or Handoff implementation details.

## Required behavior

### Initialization and negotiation

- Send ACP v1 initialize metadata/capabilities through the boundary.
- Accept only a protocol version explicitly supported by this R4B implementation.
- Disconnect/fail closed on unsupported negotiated versions.
- Preserve unknown ACP extension metadata as untrusted transport data; never treat it as authorization evidence.

### Session lifecycle

- Persistent work requires same-session continuity.
- `session/load` / resume failure, resource-not-found, adapter restart with lost context, or backend session-id mismatch must surface as typed context loss.
- Context loss must be handed upward for the Zero3 Pilot Handoff Gate; R4B must not call `session/new` to hide the loss.
- One-shot work may create a fresh session only when the frozen Executor Contract explicitly marks that semantics as acceptable.

### Prompt and updates

- Convert Zero3 prompt input to ACP prompt content without exposing ACP types upward.
- Normalize text, status, tool-call/update and terminal results into frozen Executor events.
- Producer-supplied ACP metadata is informational only and cannot grant authority.

### Cancel

- Abort/cancel must reach the active ACP prompt/session.
- Cancellation is terminal for that execution attempt and must not be remapped as retryable provider failure unless the frozen contract explicitly requires it.

### Permission

- Every ACP permission request crosses a Zero3-owned approval/policy callback.
- Unknown, malformed, timed-out or unavailable permission decisions fail closed.
- No adapter may auto-approve because it is running non-interactively.

### Typed failure mapping

R4B must provide fixtures for at least:

- provider unavailable;
- process crash / broken stdio;
- quota exhausted;
- rate limit;
- authentication unavailable;
- unsupported protocol/version/capability;
- context loss / resume required;
- cancellation;
- permission denied / unresolved.

Provider-specific details remain diagnostic data; Router policy is not decided here.

## Mandatory gates before R4B can leave draft

- `git diff --check`
- lint/typecheck
- ACP boundary unit tests
- architecture guard
- no secret/hardcoded-host regression
- Windows executable/path/spawn tests
- subprocess crash/restart tests
- permission fail-closed tests
- protocol version negotiation tests
- persistent resume/context-loss tests proving no silent `session/new`
- cancel tests
- quota and rate-limit fixtures
- no approval bypass fixture
- ACP/acpx type-leak guard
- exact-pin/no-runtime-range-launch guard

## Stop conditions

Stop and request integration-controller review if implementation requires:

- editing Session 2 Executor Core ownership paths;
- editing Router business policy;
- changing Native Codex semantics owned by Session 4;
- changing Handoff semantics owned by Session 5;
- exposing ACP/acpx types outside this directory;
- copying authentication credentials into Zero3 Pilot storage;
- accepting silent session replacement to recover from context loss.

## Next action

Wait for the integration controller to issue:

```text
BASELINE FREEZE
main_sha: <R4A-merged-main>
contract_sha: <frozen-r4a-contract-sha>
allowed_paths:
  - apps/zero3-desktop/executor-runtime/acp/*
forbidden_paths:
  - Session 2/4/5/6 owned runtime paths
```

Then rebase this branch, inspect the exact frozen R4A types, and implement the boundary against those types without inventing parallel contract definitions.
