# Security Policy

Zero3 Pilot is designed to eventually hold significant local-machine
privilege (computer use, shell, filesystem, browser automation, subagent
dispatch). Security reports are taken seriously from Phase 1 onward, even
while most of that surface is still an unimplemented placeholder.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/Taa965/zero3-pilot/security/advisories/new)
for this repository rather than opening a public issue.

Include:
- Affected component/crate and version or commit SHA.
- Reproduction steps or a minimal example.
- Impact assessment if known (e.g. which `PermissionLevel` it bypasses).

## Scope notes

- The permission model (`crates/zero3-core::permission`) is the intended
  choke point for every side-effecting action. A report that a
  provider/plugin bypasses it (self-approves, or acts above its granted
  `PermissionLevel`) is treated as high severity.
- `upstream/codex` vulnerabilities should be reported to
  [openai/codex](https://github.com/openai/codex/security) directly; this
  repository only pins a commit of it.
