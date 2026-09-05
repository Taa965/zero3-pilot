# Zero3 Pilot Unified V1 — Exact-SHA Windows Acceptance

Status: **STATIC_RELEASE_CANDIDATE / REAL_RUNTIME_NOT_RUN**

Branch: `release/zero3-pilot-unified-v1-candidate`

This branch is the first single release candidate that statically contains both major closeout lines:

- Development Group V1 (`P00–P17` + total-controller wiring);
- GPT Web + Gemini Web + Antigravity + Codex provider-neutral TaskSpecV2/review/fix/artifact/worktree closeout.

It intentionally does **not** touch `main` until exact-SHA Windows and real-runtime evidence is recorded.

## One candidate, one automated Windows entry

From a clean checkout of this branch, record the exact HEAD and run:

```powershell
$CandidateSha = (git rev-parse HEAD).Trim()
powershell -ExecutionPolicy Bypass -File scripts/acceptance/unified-release-windows.ps1 -CandidateSha $CandidateSha -BuildInstaller
```

The runner performs common work only once:

1. repository architecture guard;
2. unified release-candidate guard;
3. Development Group architecture guard;
4. Gemini/Antigravity architecture guard;
5. Development Group integrated behavior suite;
6. one shared Desktop prepare pipeline;
7. prepared GPT/Gemini/Antigravity composition guard;
8. required generated-runtime presence checks, including Development Group runtime;
9. one Desktop typecheck against the already prepared tree;
10. Development Group Skills-only package shape / 5+3 specification check;
11. optional one Windows installer build;
12. one final reset.

The evidence transcript is written outside the repository. A dirty repository or a HEAD mismatch fails closed.

## Prepared-runtime order frozen for V1

The desktop pipeline is intentionally:

```text
prepare-upstream.mjs
  -> base shell / GPT Web / Control / Remote Host overlays

prepare-gemini-integration.mjs
  -> Gemini Web / Antigravity / TaskSpecV2 / artifacts / review / worktree / task-MCP overlays

prepare-codex-upstream.mjs
  -> Development Group bridge
  -> pinned Codex overlay
```

Development Group is staged last because it composes over the final prepared Electron main/preload tree and reuses the same `zero3CodexAppServer` singleton. It does not launch a second Codex kernel.

## Release-level seam fixes already applied

The unified branch includes closeout fixes that are not feature rewrites:

- deterministic reset removes stale generated `electron/zero3` runtime state and generated GPT/Gemini sidebar files;
- Development Group `Window` type injection now anchors immediately before the stable `hermesDesktop` property instead of assuming it is the first property in `interface Window`;
- `run.mjs` and package `prepare` use the same three-stage overlay order;
- Development Group bridge remains bound to the final `prepare-codex-upstream` stage;
- the final release candidate keeps GPT/Gemini provider surfaces, TaskSpecV2, OutcomeUnknown, artifact/Git truth, Development Group Delivery/Integration/Verification/Completion truth and purpose-specific IPC boundaries.

## Automated PASS does not equal final PASS

Even if `unified-release-windows.ps1` completes, the following remain **NOT_RUN** until separately recorded on the same exact SHA.

### Provider/browser reality

- real ChatGPT login/profile persistence and isolation;
- real Gemini login/profile persistence and isolation;
- navigation/title/session persistence;
- credential/token leakage review;
- GPT/Gemini/Codex native-surface switching.

### GPT/Gemini/Antigravity/Codex task loop

- real GPT Web -> TaskSpecV2 -> Gemini/Antigravity -> authoritative ExecutionResultV2 -> GPT review;
- real `CHANGES_REQUESTED` -> bounded FixRequest -> same logical session/worktree/provider -> new immutable review cycle;
- explicit `CODEX` and `GEMINI` routes;
- observable `AUTO` selection/fallback with tri-state authentication;
- linked-worktree proof, committed changed-file capture, artifact hashes and tamper rejection;
- task-scoped MCP current-turn candidate isolation and terminal/MCP disagreement blocking;
- kill/restart ambiguity -> durable OutcomeUnknown -> explicit recovery, never automatic retry.

### Development Group reality

- real pinned-Codex Development Session;
- real permission request/response;
- clean committed Delivery materialization;
- real Integration and exact-SHA Verification;
- Completion Proof on the exact final integration SHA;
- restart/Handoff/rollback fixture;
- OutcomeUnknown evidence-bound human recovery.

### OpenAI review reality

The first public review package remains **Skills only**. MCP is a later optional capability.

Still account-side / real-environment only:

- verified publisher identity;
- privacy/support/legal listing fields;
- 5 positive + 3 negative cases executed in the actual submission-capable OpenAI environment;
- actual submission and reviewer outcome.

Authored test cases or local static package checks are not OpenAI approval evidence.

## Merge rule

Do not merge this release candidate to `main` merely because static review, GitHub mergeability, or automated Windows steps are green.

The release candidate may advance only after:

```text
exact candidate SHA frozen
+ automated Windows runner PASS
+ required real provider/runtime gates PASS
+ Development Group real-runtime gates PASS
+ installer PASS when included in the release
+ blockers = 0 (or explicitly accepted non-release polish only)
```

If a real test fails, repair this release branch (or a narrow child branch), produce a **new exact SHA**, and rerun only the unified final acceptance against that new SHA. Never carry PASS evidence from an older candidate SHA forward.
