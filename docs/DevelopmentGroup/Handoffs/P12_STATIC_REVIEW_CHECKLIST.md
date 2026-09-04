# P12 Static Review Checklist

Review mode: static code/integration review only. No Linux authenticity test, compilation or media/runtime claim is made here.

- [x] P02–P11 integration ancestry reused rather than reimplemented.
- [x] Development Group product composition root added.
- [x] Same pinned Codex app-server reused through Zero3Executor.
- [x] Renderer has bounded Group IPC only; no generic Codex RPC.
- [x] Existing #49 AppServer session-source/list-source persistence overlay retained.
- [x] Session worktrees are isolated and ignored by integration root.
- [x] Requirement ownership scopes are explicit and IPC-validated.
- [x] Cross-Session overlapping globs cannot retain double-write authority.
- [x] Delivery/Handoff/HEAD/diff/hash evidence is generated in Electron main.
- [x] Live Handoff fingerprint re-sampling uses the Handoff Builder algorithm.
- [x] Failure attribution and bounded RepairTask retry are connected.
- [x] OutcomeUnknown is excluded from automatic retry.
- [x] Repaired Deliveries can re-enter integration by delivery hash.
- [x] Frozen verification-policy hash/revision gates final verification.
- [x] Verification execution uses JSON argv with `shell:false`.
- [x] Completion Proof remains exact-final-SHA and fail-closed.
- [x] Development Group route/sidebar/page are wired through the pinned Hermes contribution API.
- [x] Pinned Hermes `.ts` import compatibility is handled in copied overlay sources rather than by loosening upstream tsconfig.
- [x] One-shot Windows exact-SHA acceptance command is authored.
- [x] Bundled Codex app-server and cold-restart persistence smokes are part of the final Windows gate.
- [ ] Exact post-merge Windows typecheck/test/package/smoke/installer acceptance — **NOT_RUN until P12 is merged into integration**.
