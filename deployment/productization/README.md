# Zero3 Pilot productization foundation

This directory is the Wave 0 / Session 8 productization boundary. It turns the current single-host deployment into a provider-neutral design without changing runtime authority, H5 lease/fencing/outbox semantics, or any Executor private type.

## Scope in this phase

- audit self-use deployment assumptions;
- define a generic Linux self-host contract that can be implemented with systemd or Docker;
- define the AWS Quick Deploy resource graph as one optional deployment template;
- freeze a provider-neutral pairing v1 protocol proposal;
- freeze UI view-model/data contracts for Settings -> Executors, Settings -> Remote Control, and Task -> Executor/Handoff Timeline.

## Explicit non-goals

- no `/api/pair/v1/*` runtime implementation yet;
- no Executor Manager or Handoff runtime binding before the R4 contracts are frozen by the integration controller;
- no replacement of the current production deployment workflow in this branch;
- no AWS SDK dependency in Zero3 Pilot protocol/runtime code;
- no storage of long-lived AWS access keys in Zero3 Pilot;
- no second agent loop, scheduler, shell executor, or generic RPC proxy.

## Files

- `AUDIT.md` - concrete hard-coded/self-use assumptions and migration disposition.
- `SELF_HOST.md` - generic Linux topology, install layout, health, HTTPS and upgrade contract.
- `self-host.env.example` - secret-free environment/path contract compatible with the current H5 server.
- `AWS_QUICK_DEPLOY.md` - CloudFormation resource graph and security boundaries.
- `PAIRING_V1.md` - one-time pairing and per-node credential protocol proposal.
- `UI_DATA_CONTRACT.md` - UI-only view models that deliberately do not import R4 runtime private types.

The existing files directly under `deployment/` remain the current production implementation until a later, separately gated migration PR replaces them.