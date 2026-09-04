# P12 — Development Group V1 Product Wiring Closeout

Status: **STATIC_CLOSEOUT_READY / WINDOWS_FINAL_ACCEPTANCE_NOT_RUN**

Source integration baseline: `integration/development-group-v1@2fbe6b8926364b5fc90943c8cd62215b3c4aa210`

Closeout branch: `closeout/development-group-v1-product-wiring`

## 1. Scope

P12 does not redo P02–P11. It connects their already-integrated contracts and modules into the real Zero3 Pilot desktop product boundary and closes cross-module gaps found during static integration review.

The runtime authority remains frozen:

`DevelopmentGroup -> DevelopmentSession -> Zero3Executor -> NativeCodexExecutor -> existing zero3CodexAppServer -> Codex Root Thread -> Codex native Subagents`

No second Agent Kernel, no generic Renderer-to-Codex RPC and no permission bypass are introduced.

## 2. Product wiring completed

- Added `DevelopmentGroupProductService` as the Electron-main composition root for Group runtime.
- Reused the **same** `zero3CodexAppServer` already owned by the desktop shell.
- Registered `NativeCodexExecutor` through `Zero3ExecutorManager`.
- Added bounded IPC only for Group list/get/create, Session start/retry/cancel/permission response, Delivery finalization, controlled integration and final verification.
- Added `/development-groups` through the pinned Hermes contribution registry and a Chinese sidebar entry `开发组`.
- Added Group/Session/Requirement/Wave/Integration/Verification/Failure/Repair projections.
- Added live Codex permission-request handling in the Development Group page.

## 3. Evidence authority / Delivery closeout

Renderer text is not delivery evidence.

After a successful Session turn reaches `delivering`, Electron main now derives the authoritative evidence from the bound worktree:

- exact branch and HEAD;
- changed paths from frozen baseline;
- clean/dirty state;
- Handoff checkpoint;
- DevelopmentDelivery;
- Delivery hash;
- ownership audit.

The Session prompt requires intended changes to be committed and the worktree clean before Delivery finalization. The agent never self-merges.

A cross-module P03/Executor mismatch was fixed: the Delivery Gate previously mixed its own workspace fingerprint with the Handoff Builder's `dirty_worktree_fingerprint`. The real Git adapter now re-samples the Handoff fingerprint with the same `captureWorkspaceState()` algorithm used by the Handoff Builder, while preserving the separate Delivery workspace fingerprint. A stale Handoff fingerprint regression test was added.

## 4. Ownership isolation closeout

Product create requests now require explicit repository-relative path scopes for every Requirement.

Fail-closed input rules reject:

- missing path scopes;
- absolute paths;
- `..` traversal;
- `.git` / `.zero3` scopes;
- repository-wide `*`, `**`, `**/*` and equivalent broad scopes.

Planning now recognizes overlapping globs instead of only identical path strings. It prefers to co-locate overlapping scopes in one Session; if explicit Controller partitions or other limits still separate overlapping scopes, both overlapping scopes are downgraded to shared/read-only rather than allowing double-write authority.

Managed worktrees live under `.zero3/worktrees/` and that path is ignored by the integration worktree.

## 5. Failure / bounded repair closeout

P08 is wired into the product path without inventing a second repair-agent runtime:

- failed/blocked Sessions create `FailureRecord` evidence;
- attributable failures can create bounded `RepairTask` records;
- retry is allowed only for `blocked`/`failed`, only with a planned RepairTask and remaining attempt budget;
- `OutcomeUnknown` remains human-only and is never blindly retried;
- repaired Sessions can produce a new Delivery and re-enter integration by **delivery hash**, even if an older Delivery from the same Session was previously merged;
- repaired Session blockers are cleared only after a new accepted Delivery.

## 6. Verification / completion closeout

The repository now contains `.zero3/verification-policy.json` with frozen revision `zero3-pilot-dg-v1-2026-09-04.1`.

Mandatory Group-completion commands are JSON argv and executed with `shell:false`:

1. `development-group-product-audit`
2. `desktop-typecheck`

The product runtime pins the exact verification-policy hash and revision at Group creation. Final verification fails closed if the policy changes, the integration branch is wrong, the worktree is dirty, a required command is missing/not-run, or verification changes HEAD/worktree state.

Completion Proof is emitted only for the final exact integration SHA after current Deliveries are merged and mandatory verification passes.

## 7. Codex session-persistence preservation

P12 reuses the existing transport and retains the merged #49 persistence overlay:

- app-server launch is patched to `--session-source app-server`;
- `thread/list` is constrained to `sourceKinds: ['appServer']`.

The final Windows gate also runs the bundled Codex cold-restart persistence smoke so Development Group wiring cannot silently regress #49.

## 8. Pinned Hermes overlay compatibility

P02–P10 source modules use explicit `.ts` relative import suffixes, while the pinned Hermes Electron TypeScript configuration does not enable `allowImportingTsExtensions`.

P12 does **not** loosen Hermes compiler policy. The reviewed overlay copier strips only relative `.ts/.tsx` suffixes in the copied Hermes build tree. Source modules and their tests remain unchanged.

## 9. One-shot Windows final acceptance

Entry point:

```powershell
npm --prefix apps/zero3-desktop run acceptance:dg:win
```

For an exact candidate SHA, prefer:

```powershell
$env:ZERO3_EXPECTED_SHA = '<EXACT_INTEGRATION_SHA>'
npm --prefix apps/zero3-desktop run acceptance:dg:win
```

The command performs one consolidated Windows acceptance rather than repeating P02–P11 development work:

1. exact candidate identity + clean root;
2. reviewed upstream submodule pins;
3. Development Group static wiring audit;
4. architecture guard;
5. real pinned-desktop overlay preparation + TypeScript typecheck;
6. all Development Group + Executor TypeScript contract tests;
7. prepared desktop lint;
8. prepared UI tests;
9. prepared Electron platform tests;
10. real Windows Codex-native package build;
11. `Zero3Pilot.exe`, `app.asar`, bundled pinned `codex.exe` and legal-resource evidence;
12. bundled `codex.exe --version`;
13. bundled app-server JSONL smoke;
14. bundled cold-restart Session persistence smoke;
15. NSIS installer existence + SHA-256.

A machine-readable report is written to `%TEMP%\zero3-pilot-development-group-closeout.json` unless `ZERO3_DG_ACCEPTANCE_REPORT` overrides it.

## 10. Validation truth table

| Gate | Status at P12 handoff |
| --- | --- |
| P02–P11 code present in integration ancestry | PASS |
| P12 static cross-module review | PASS |
| Product composition / bounded IPC authored | PASS |
| Renderer route/page authored | PASS |
| Delivery/Handoff authority wiring authored | PASS |
| Failure/repair wiring authored | PASS |
| Frozen verification policy authored | PASS |
| One-shot Windows acceptance runner authored | PASS |
| Real prepared-desktop TypeScript typecheck on P12 candidate | **NOT_RUN** |
| Real Group/Executor tests on P12 candidate | **NOT_RUN** |
| Real Windows package on P12 candidate | **NOT_RUN** |
| Bundled Codex app-server/persistence smoke on P12 candidate | **NOT_RUN** |
| Installer SHA-256 on P12 candidate | **NOT_RUN** |
| Development Group final Completion Proof from real product execution | **NOT_RUN** |

## 11. Merge gate

P12 may be merged into `integration/development-group-v1` as the static product-wiring closeout.

Do **not** promote the Development Group integration result to `main` as fully accepted until the one-shot Windows command passes against the exact post-merge integration SHA and its report is reviewed.

P11 OpenAI public Plugin submission readiness remains a separate external/public-review track. Production public HTTPS MCP endpoint, tool scan, legal/publisher evidence, production 5+3 tests and OpenAI review are not claimed by P12.
