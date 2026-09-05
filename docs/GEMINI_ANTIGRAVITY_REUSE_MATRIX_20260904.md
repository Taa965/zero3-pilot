# Zero3 Pilot Gemini / Antigravity Reuse Matrix — 2026-09-04

> Integration branch: `feature/gpt-web-gemini-antigravity-v1`  
> Parent baseline: `feature/gpt-web-codex-unified-workspace-v1@640471f2db1651616cc5706a41a7a54946172f0f`  
> Source plan: `Zero3_Pilot_GPT_Web_x_Gemini_Antigravity_无感协作审核闭环开发方案_V1.0.md`  
> Decision tags: `REUSE` / `EXTEND` / `NEW` / `DO NOT REUSE`.

## 1. Architecture decision

The plan is valid with one important repository-specific correction:

**Zero3 already has a generic Rust provider seam and `ProviderRegistry<T>`. Do not create a second unrelated Provider Registry.**

Existing authoritative boundaries remain:

```text
Codex open source
= default authoritative Agent Kernel / default hands & feet

Gemini Web
= presentation surface only

Antigravity CLI
= external specialist agent runtime under Zero3 orchestration

Zero3
= project extension state / provider registry / routing / handoff / review lifecycle

Git / Verification / Artifact evidence
= completion truth
```

Antigravity is treated like an external collaborator provider, not a replacement primary Agent Kernel.

## 2. Repository findings

| Capability | Existing implementation | Decision | Gemini V1 action |
|---|---|---|---|
| Generic Provider trait | `crates/zero3-providers/src/provider.rs` | REUSE | Extend provider metadata/capability snapshot without breaking current providers |
| Generic Provider Registry | `crates/zero3-providers/src/registry.rs` | REUSE/EXTEND | Add typed logical-agent descriptors and health snapshots on top; do not duplicate registry |
| Event model | `crates/zero3-core/src/event.rs` | REUSE/EXTEND | Add provider/runtime/review events while preserving existing append-only semantics |
| Event persistence | `crates/zero3-store` JSONL `EventStore` | REUSE | Runtime/audit events may be projected into provider-specific durable stores; event log remains usable for correlation |
| GPT Web Browser Provider | `apps/zero3-desktop/gpt-web-runtime` | REUSE PATTERN | Extract/re-express common secure WebContentsView patterns for Gemini, but use a separate session partition |
| GPT browser profile | `persist:zero3-chatgpt` | DO NOT REUSE PROFILE | Gemini must use `persist:zero3-gemini`; no cookie store sharing |
| Workspace Entry Registry | `workspace-runtime` | EXTEND | Add provider/logical-session metadata; do not turn it into conversation authority |
| Codex App Server | existing typed `window.zero3Codex` path | REUSE | Codex stays default implementation/build/test/Git executor |
| H5 canonical remote task state machine | `apps/web/src/control_plane.rs` | REUSE | Do not build a second task state machine for Gemini |
| H5 task extension sidecar | `apps/web/src/control_extensions.rs` | EXTEND | Store target/provider/logical-session/review metadata alongside canonical task |
| Desktop Control Plane bridge | `apps/zero3-desktop/control-runtime` | EXTEND | Add target-aware dispatch; control token remains Electron-main only |
| ProjectContext MCP | packaged `zero3-project-context` server | EXTEND | Antigravity gets task-scoped read/write tools through a dedicated gateway surface |
| Remote Codex ExecutionResult | `zero3.pilot.execution-result.v1` | EXTEND | Introduce provider-neutral V2 result envelope while accepting Codex V1 result during migration |
| Completion evidence gate | `remote-completion-gate.ts` | REUSE/EXTEND | Gemini gate uses artifact/verification/scope/evidence, not agent self-report |
| Git pre/postflight | pinned Codex `command/exec` path | REUSE FOR CODEX | Gemini does not create a separate Git truth model; Gemini worktree evidence follows the same branch/base/head conventions |
| Worktree isolation | current task workspace model / Codex Git ownership | EXTEND | Each Gemini writable task gets a dedicated worktree; no shared writable worktree with Codex |
| Artifact store | no canonical first-class V1 store found in current integration path | NEW | Add content-addressed task artifact metadata/store |
| Review cycle store | no canonical task review state machine found | NEW | Add append-only/versioned ReviewPacket/Decision/FixRequest cycles |
| Agent Router | no canonical provider-target router in current desktop/control path | NEW | Explainable policy: explicit target wins; otherwise task-type preference |
| Gemini Web | none | NEW | `WebContentsView`, real `gemini.google.com`, separate persistent profile |
| Antigravity runtime adapter | none | NEW | Official `agy` headless + NDJSON event parser + conversation persistence |
| Antigravity credentials | official CLI cache | REUSE OFFICIAL AUTH ONLY | Detect auth state; never read/export credential secrets |
| Legacy Gemini CLI consumer OAuth | none required | DO NOT REUSE | Not V1 consumer baseline |
| Gemini web DOM automation | none | DO NOT BUILD | No selector/click/type/scrape transport |
| Generic Node agent loop | retired by constitution | DO NOT BUILD | Antigravity adapter is a narrow external-agent process adapter only |
| Unified provider UI | GPT/Codex transitional sidebar | EXTEND/REPLACE PRESENTATION | Build provider-neutral presentation contracts suitable for GPT/Gemini/Codex and upcoming new UI |

## 3. Official Antigravity assumptions frozen for V1

The adapter contract assumes the official CLI supports:

```text
agy -p <prompt>
--output-format json
--output-format stream-json
--input-format stream-json
--conversation <conversation_id>
--json-schema <schema>
--sandbox
```

Streaming mode contract used by Zero3:

```text
stdin user event -> stdout NDJSON
init -> step_update* -> result
```

The V1 adapter must treat the final `result.status` as machine state, preserve the `conversation_id`, and treat process exit without a terminal result as `OUTCOME_UNKNOWN`.

Authentication is an official cached Antigravity session established interactively by the user. Zero3 may report authenticated/auth-required/auth-expired state, but must never extract credential values.

## 4. Contract freeze direction

### Provider identity

```text
LogicalAgent = GPT | GEMINI | CODEX
SessionProvider = CHATGPT_WEB | GEMINI_WEB | CODEX_LOCAL | GEMINI_AGENT
AgentTarget = CODEX | GEMINI | AUTO
```

### Gemini logical session

One visible Gemini logical session may bind:

```text
logicalSessionId
projectId
webEntryId?
runtimeSessionId?
runtimeConversationId?
status
role/title
```

Web and runtime authentication remain independent.

### Provider-neutral task/review truth

Do not share full conversation transcripts. Cross-provider context is limited to:

```text
ProjectContext
TaskSpecV2
Contracts/Decisions
Artifacts
GitState
Verification
ExecutionResult
ReviewPacket
ReviewDecision
FixRequest
```

## 5. Six-lane implementation freeze

P01 — Provider contracts / registry
- extend existing Rust Provider Registry;
- logical-agent/provider descriptors;
- capability snapshot;
- cross-agent binding;
- durable provider/review contract schemas.

P02 — Gemini Web Provider
- separate persistent partition;
- real Gemini web surface;
- URL/title/session binding;
- logical-session link;
- fallback external browser.

P03 — Antigravity Runtime Adapter
- `agy` discovery;
- official auth-status classification;
- persistent stream-json process;
- NDJSON parser;
- conversation persistence;
- interrupt/resume;
- fail-closed OutcomeUnknown.

P04 — Router / Handoff / Review Loop
- target-aware TaskSpecV2;
- provider policy;
- dispatch target Gemini/Codex;
- Result -> ReviewPacket;
- ReviewDecision/FixRequest;
- cycle monotonicity;
- same Gemini conversation for fixes.

P05 — MCP / Git / Artifact / Evidence
- task-scoped Zero3 MCP gateway contracts;
- content-addressed Artifact store;
- Gemini worktree evidence;
- verification truth states (`PASSED/FAILED/NOT_RUN/BLOCKED`);
- OutcomeUnknown reconciliation.

P06 — Unified UI / integration
- GPT/Gemini/Codex provider picker;
- Gemini logical session row;
- web/runtime/review tabs;
- action bar;
- review-cycle history;
- target dispatch UI;
- no DOM task transport.

## 6. Merge / validation rule

```text
P01
 -> P02 + P03
 -> P04
 -> P05
 -> P06
 -> one integration wiring pass
 -> one static total audit
 -> one Windows truth acceptance pass
```

The final integration stage must not redo development already delivered by the six lanes.
