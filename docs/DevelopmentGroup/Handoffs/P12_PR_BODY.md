## P12 Development Group V1 product-wiring closeout

This PR is the **total-control static closeout** after P02–P11 were integrated. It does not redo their implementation.

### What is connected

- real Electron-main `DevelopmentGroupProductService` composition;
- same existing `zero3CodexAppServer` through `Zero3Executor -> NativeCodexExecutor`;
- bounded Development Group IPC and `/development-groups` product UI;
- main-process authoritative Delivery/Handoff/Git evidence;
- explicit Requirement ownership scopes and overlapping-glob isolation;
- controlled integration, failure attribution, bounded RepairTask retry and exact-SHA Completion Proof;
- frozen `.zero3/verification-policy.json`;
- one-shot exact-SHA Windows final acceptance command.

### Cross-module defects fixed during closeout

1. P02–P10 existed as modules but were not wired into the real Electron/preload/renderer product path.
2. Renderer-supplied Delivery/Handoff evidence was replaced by Electron-main Git/Handoff evidence authority.
3. Handoff `dirty_worktree_fingerprint` and Delivery workspace fingerprint used different algorithms; the real Git adapter now re-samples with the Handoff Builder algorithm.
4. Requirement creation without `pathHints` produced Sessions with no real ownership; product creation now requires bounded scopes.
5. `src/**` vs `src/foo/**` style cross-Session overlap could retain double-write authority; overlap is now co-located when possible and otherwise downgraded to shared/read-only.
6. Failed/integration-conflict/verification paths were not connected to P08 failure/repair records; bounded repair is now wired without creating a second agent runtime.
7. Managed `.zero3/worktrees/` could contaminate integration-root status; it is now ignored.
8. P02–P10 explicit `.ts` import suffixes did not match the pinned Hermes Electron tsconfig; copied overlay sources normalize only relative TS suffixes without loosening upstream compiler policy.

### Authority preserved

`DevelopmentGroup -> DevelopmentSession -> Zero3Executor -> Codex Root Thread -> Codex native Subagents`

- no generic Renderer -> Codex RPC;
- no second Agent Kernel or repair-agent loop;
- no permission bypass;
- `OutcomeUnknown` is not auto-retried;
- #49 `--session-source app-server` and `sourceKinds:['appServer']` persistence semantics are retained.

### Validation truth

Static review / authored gates: **PASS**.

Exact post-merge Windows typecheck, contract tests, Electron/UI tests, package build, bundled Codex smokes and installer checksum: **NOT_RUN** in this web closeout.

After merge into `integration/development-group-v1`, run exactly once on the post-merge SHA:

```powershell
$env:ZERO3_EXPECTED_SHA = '<POST_MERGE_INTEGRATION_SHA>'
npm --prefix apps/zero3-desktop run acceptance:dg:win
```

Do not promote the Development Group integration candidate to `main` until that whole one-shot command passes and the generated report is reviewed.

P11 OpenAI public Plugin submission remains a separate external review track and is not claimed complete by this PR.
