# Security Policy

Zero3 Pilot is a **pre-release** desktop-agent project that already integrates several high-privilege boundaries: Codex tool/shell/file execution, approvals, local workspace state, Remote Host control-plane flows, executor switching and durable handoff state. Security is therefore treated as an architecture constraint, not a post-release hardening step.

## Supported versions

Zero3 Pilot has not published a stable GitHub Release yet.

| Version | Security support |
| --- | --- |
| `main` / active pre-release candidate | Best-effort security fixes and review |
| Old development branches / superseded PRs | Not supported |
| Future tagged pre-releases | Support policy will be stated in each release |

Until the first public tag exists, a security fix is considered supported only after it is reviewed and merged to the current `main` baseline.

## Reporting a vulnerability

**Do not open a public issue for a suspected security vulnerability.**

Use GitHub's [private vulnerability reporting](https://github.com/Taa965/zero3-pilot/security/advisories/new) for this repository.

Please include, when available:

- affected component/path and commit SHA;
- operating system and relevant runtime versions;
- minimal reproduction steps or proof of concept;
- the authority/permission boundary you believe is bypassed;
- impact assessment;
- whether the issue depends on a specific upstream Codex/Hermes/DeepSeek-Harness revision.

Do not include real access tokens, API keys, cookies, private repository contents or other user secrets in a report unless GitHub's private advisory flow explicitly requires a minimal redacted sample.

## Security-sensitive boundaries

The following classes are considered especially important.

### Codex runtime authority

Open-source Codex is the authoritative native Agent Kernel/runtime. A path that silently routes a migrated core operation through Hermes Runtime, legacy Zero3 Node or an unreviewed parallel agent loop is an architecture/security issue.

The Renderer must not receive a generic arbitrary Codex JSON-RPC tunnel. New Codex capabilities require named reviewed surfaces.

### Approval and permission integrity

Unsupported server-request/permission classes are expected to fail closed. A provider, UI adapter or external executor must not self-approve or elevate a permission beyond the decision represented by the reviewed authority boundary.

Reports that allow command/file/tool actions to bypass the expected approval/policy decision are high priority.

### Credentials and authentication

The Native Codex executor is designed to use supported Codex account/runtime APIs. It must not read, export, copy or serialize Codex credential files/tokens as an integration shortcut.

Secret values entered through user-input flows must not be persisted into ordinary presentation/history stores unless an explicit reviewed design says otherwise.

### Executor and handoff authority

External executors are providers beneath Zero3-owned Task/Execution, Router and Handoff authority. A provider must not be able to:

- create replacement task authority;
- forge failure provenance to force a switch;
- acquire/transfer workspace writer authority without the Handoff protocol;
- resume a missing context by silently starting a different session;
- bypass a generation/checkpoint/fencing decision.

### Remote Host and control plane

Remote Host reliability/security depends on durable task identity, authenticated host/control surfaces, leases, fencing, ordered durable outbox publication and terminal/replay idempotency.

Reports involving stale-host execution, fencing bypass, replay that duplicates side effects, task-content identity confusion, or publication that overtakes older committed evidence are security-sensitive.

### Upstream/overlay supply chain

`upstream/codex`, `upstream/hermes-agent` and `upstream/deepseek-harness` are pinned upstream sources. Zero3-specific Codex changes are managed through reviewed overlay/provenance rules.

A change that bypasses pin verification, introduces an unmanaged/unlisted Codex patch, or causes an unexpected upstream source to be executed should be treated as a supply-chain concern.

## Upstream vulnerabilities

If the vulnerability exists in unmodified upstream Codex itself, report it to the upstream project's security channel as appropriate. Zero3 Pilot pins Codex and may still need a pin/update or integration mitigation, so please also report here when the Zero3 distribution/integration is directly affected.

For vulnerabilities specific to Zero3 adapters, overlays, Remote Host, executor/handoff logic or desktop integration, report to Zero3 Pilot directly through the private advisory link above.

## Public disclosure

Please allow time for triage and a coordinated fix before public disclosure. Because the project is pre-release, remediation may include disabling or failing closed a feature until a safe implementation is available.

Security fixes should preserve the architecture constitution rather than introducing a second runtime, hidden credential path or approval bypass as a workaround.

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md), [`docs/UPSTREAM.md`](docs/UPSTREAM.md) and [`ROADMAP.md`](ROADMAP.md) for related authority and release rules.
