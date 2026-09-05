---
name: Bug report
about: Report reproducible Zero3 Pilot behavior that does not match the current contract
title: "[bug] "
labels: bug
---

> **Security issue?** Do not post credentials, tokens, private repository contents, or vulnerability details here. Use the private reporting path in `SECURITY.md` instead.

## Affected area

Select or describe the closest boundary:

- [ ] Codex app-server / Thread / Turn / Item integration
- [ ] Desktop UI / typed Electron IPC
- [ ] Approval / permission / sandbox behavior
- [ ] Codex overlay / D1-D2 retention
- [ ] Remote Host / control plane
- [ ] Executor / Native Codex / Handoff / Failover
- [ ] Legacy/extension component
- [ ] Build / CI / packaging
- [ ] Other:

## Version / exact source

- Zero3 Pilot tag (if any):
- Commit SHA:
- Branch:
- Was this reproduced from a clean checkout/submodule state? yes/no

## Environment

- OS + version:
- CPU architecture:
- Node version (if relevant):
- Rust/Cargo version (if relevant):
- Codex authentication mode (describe only the mode; **do not paste credentials**):
- Other relevant runtime/tool versions:

## What happened?

Describe the observed behavior and why it is incorrect.

## Expected behavior

What should have happened according to the current UI/architecture/runtime contract?

## Reproduction

Provide the smallest reliable sequence:

1.
2.
3.

Does it reproduce consistently? If intermittent, estimate frequency.

## Evidence

Attach or paste **redacted** logs, screenshots, failing test names, workflow/job links, or minimal examples. Remove secrets and unrelated private data.

For persistence/recovery issues, include whether the process/app was restarted and whether the same workspace / `CODEX_HOME` / task identity was reused.

## Authority / safety impact

Does the bug appear to involve any of these?

- [ ] unexpected legacy-runtime fallback
- [ ] approval/permission bypass
- [ ] credential handling
- [ ] duplicated side effects / replay
- [ ] task/thread/session identity loss
- [ ] lease/fencing/handoff writer authority
- [ ] provider/failover misclassification
- [ ] none known

If any sensitive boundary appears exploitable, stop posting public details and move the report to the private security channel.

## Regression information

- Last known good commit/tag, if known:
- First known bad commit/tag, if known:
- Related PR/issue, if known:

## Additional context

Anything else needed to reproduce or distinguish this from a known pre-release limitation.
