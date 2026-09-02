# Deployment and distribution

## Current product target

Zero3 Pilot's current public product target is a **local desktop application**, not the legacy `zero3-web` server prototype.

The authoritative native Agent Kernel/runtime is the repository's reviewed open-source Codex pin, reached through the Zero3-owned typed `codex app-server` boundary. The first public distribution target is the Codex-native Windows Electron/React package documented in [`WINDOWS_INSTALL.md`](WINDOWS_INSTALL.md).

For `v0.1.0-alpha`, release/distribution means:

1. choose one exact reviewed repository SHA;
2. require the release-blocking architecture/Codex/Windows/feature gates on that candidate;
3. build the exact pinned Codex source used by that candidate;
4. package the Windows desktop shell with that `codex.exe` under application resources;
5. verify the binary **inside the package** with a real app-server smoke;
6. verify required upstream license/NOTICE material is present;
7. produce the actual NSIS installer and SHA-256;
8. publish only that evidence-matched artifact as a GitHub pre-release.

A build from a standalone feature branch is useful validation but is not release evidence until the combined candidate containing all first-alpha blockers has been revalidated.

## Runtime authority

The desktop distribution must preserve the architecture constitution:

- Codex is the only native Agent Kernel/runtime authority;
- the Renderer does not receive a generic arbitrary Codex JSON-RPC tunnel;
- migrated core behavior does not silently fall back to Hermes Runtime or legacy Zero3 Node;
- Hermes-derived runtime behavior may remain temporarily only as compatibility scaffolding for unported UI surfaces;
- external executors, Remote Host integrations and capability donors do not acquire native-kernel authority by being present in the repository.

See [`ARCHITECTURE_CONSTITUTION.md`](ARCHITECTURE_CONSTITUTION.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`../SECURITY.md`](../SECURITY.md).

## Windows distribution

The first-alpha candidate path is tracked by the dedicated Windows Alpha Artifact gate. The intended package includes:

```text
Zero3Pilot.exe
resources/
  app.asar
  zero3-codex/
    codex.exe
  legal/
    ...reviewed license and NOTICE files...
```

Packaged mode must not replace the reviewed core with PATH, `@latest`, a runtime download or an arbitrary external binary override.

The final installer filename, tag SHA and SHA-256 belong in the final release record only after the exact combined candidate has passed.

## Update / hosting status

`v0.1.0-alpha` does not claim a production auto-update service, cloud control plane or hosted SaaS deployment. Any future update channel must preserve exact-version provenance, signing/integrity evidence and the Codex-core authority boundary.

Remote Host work in this repository is an integration/control-plane capability, not a declaration that the Zero3 desktop product itself is centrally hosted.

## Historical server deployment

Earlier Zero3 Pilot revisions included an independently deployed Rust web/control prototype and repository automation for a Linux host. That work is part of project history and may still exist in legacy code, deployment scripts or old commits, but it is **not the current desktop product deployment model and not the `v0.1.0-alpha` distribution path**.

Old host addresses, service-unit procedures and prototype DNS/certificate instructions are intentionally not treated as current release documentation here. Maintainers investigating that legacy path should use the relevant historical commit rather than applying old server instructions to the Codex-native desktop product.

## Release evidence source of truth

Before publication, use [`../docs/RELEASE_PROCESS.md`](RELEASE_PROCESS.md), [`../ROADMAP.md`](../ROADMAP.md), [`../CHANGELOG.md`](../CHANGELOG.md), the `v0.1.0-alpha` readiness issue, and the exact candidate's GitHub Actions results as the source of truth.

If those sources disagree with an older design/migration document, the architecture constitution plus the exact release-candidate evidence wins; stale documentation must be corrected before the tag is presented as a release.
