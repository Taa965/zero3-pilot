# R4B ACP External Executor Runtime

Status: **FORMAL RUNTIME — Session 0 takeover**

R4B is an external-executor transport boundary below the frozen `zero3.pilot.executor.v1` contract. Open-source Codex remains the only Native Agent Kernel.

## Runtime rules

- ACP v1 only.
- Adapter packages are exact-pinned in `compatibility-pins.json`.
- Production launch resolves an already-installed package root, verifies exact package name/version, resolves its declared bin inside that package root, and starts it without a shell.
- No `npx`, `@latest`, semver-range runtime resolution, registry lookup, or download path exists here.
- ACP/provider types stay below `executor-runtime/acp/**`.
- `session/new` is used only by `Zero3Executor.start`.
- `Zero3Executor.resume` loads durable provider-owned session metadata and calls ACP `session/load`; failure becomes `context_lost` and never falls back to `session/new`.
- ACP `session/request_permission` is projected into the frozen Zero3 permission event. Approval is returned only through `respondPermission` and only by matching an offered ACP permission option. Missing approval options fail closed.
- Router/failover/Handoff policy remains outside R4B.

## Exact compatibility pins

The frozen compatibility manifest records the audited production versions. These are compatibility pins, not a request to track the ecosystem's latest release automatically.

## Provider setup

A caller provisions an `AcpAdapterSpec` with an absolute installed package root, exact package name/version, and bin name. `resolveExactLocalAcpAdapter` verifies that installation before `AcpExternalExecutor` can use it.

This supports Claude ACP as the primary external executor and allows an optional external Codex ACP compatibility executor without granting it Native Agent Kernel authority.
