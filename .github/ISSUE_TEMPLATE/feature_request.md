---
name: Feature request
about: Propose a capability that fits Zero3 Pilot's Codex-core architecture
title: "[feature] "
labels: enhancement
---

## Problem / user outcome

What real problem should this solve? Describe the desired user outcome before proposing implementation details.

## Proposed capability

What should Zero3 Pilot do differently?

## Where should it live?

Choose the narrowest appropriate authority layer:

- [ ] Codex-native extension / reviewed Codex seam
- [ ] Desktop UI / presentation / typed IPC
- [ ] Zero3 tool/provider/MCP capability
- [ ] Executor / external-agent adapter
- [ ] Handoff / Router / failover policy
- [ ] Remote Host / control plane
- [ ] Deployment / packaging / onboarding
- [ ] Documentation / maintainer workflow
- [ ] Unsure — needs architecture discussion

Explain why this is the correct layer.

## Runtime-authority impact

How does the proposal preserve open-source Codex as the authoritative native Agent Kernel/runtime?

Does it require a new agent loop, generic RPC tunnel, legacy-runtime fallback, or a provider gaining Task/Router/Handoff authority? If yes, explain why the same outcome cannot be achieved through the existing reviewed boundaries.

## Upstream Codex impact

- [ ] No Codex pin/Core/overlay change required
- [ ] Codex extension/overlay change required
- [ ] Codex Core patch may be required
- [ ] Codex pin bump may be required

If touching Codex, describe the extension gap and follow `docs/UPSTREAM.md`. A Core patch/pin bump should not be hidden inside unrelated product work.

## Security / permission impact

Does this affect:

- [ ] shell/files/browser/computer side effects
- [ ] approvals / sandbox / permission policy
- [ ] credentials / authentication
- [ ] Remote Host auth / leases / fencing / replay
- [ ] Executor / Handoff writer authority / failover
- [ ] persisted sensitive data
- [ ] none known

Describe the intended fail-closed behavior where relevant.

## Durability / identity requirements

If the feature resumes, retries, switches providers, crosses machines, or mutates history, which identities must remain authoritative (Thread/Turn, task/execution, generation/checkpoint, lease/fencing, workspace, etc.)?

## Alternatives considered

What simpler extension, UI-only solution, or existing Codex capability was considered first?

## Validation plan

What would constitute real evidence that this works: unit tests, real pinned-Codex smoke, Windows target-shell gate, restart/recovery test, Remote Host test, benchmark, etc.?

## Release / roadmap relevance

Is this needed for the next pre-release, or can it follow after `v0.1.0-alpha`? Explain why.

## Additional context

Links to related issues/PRs/upstream discussions or design references.
