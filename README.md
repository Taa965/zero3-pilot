# Zero3 Pilot

**A personal computer agent platform built on the open-source Codex runtime.**

Zero3 Pilot combines:

- **Codex execution maturity** — the agent loop, tool-calling, and CLI/runtime
  discipline of [openai/codex](https://github.com/openai/codex).
- **DeepSeek Harness extensibility** — capability-seam plugins, an event
  log, background jobs, subagent providers, and profiles, re-expressed as
  Rust-native abstractions rather than embedded wholesale.
- **Open Computer Use** — Windows/macOS/Linux computer control via
  [`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use)
  behind a swappable provider trait.
- **Personal memory, automation, and subagents** — a scheduler, an approval
  policy layer, and multi-worker (Claude / Codex / Hermes) subagent dispatch.

It is not "a Codex fork with some extra tools." It's a platform that treats
Codex as one dependency among several, keeps `upstream/codex` cleanly
syncable (see [`docs/UPSTREAM.md`](docs/UPSTREAM.md)), and builds the
personal-computer-agent layer — computer use, browser automation, file
system, shell, MCP, skills, hooks, background jobs, scheduler, event log,
memory, subagents, plugins, desktop/web UI, remote access — as extensions
around it.

## Status

Phase 1: architecture and extension seams only. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what's real vs. a
placeholder today, and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for why
hosting is deliberately deferred rather than pointed at an unrelated
production server.

## Getting started

```bash
cargo build --workspace
cargo test --workspace
cargo run -p zero3-web   # serves GET /health on :8787
```

## Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Notices

- Zero3 Pilot is an independent, unofficial project. It is **not** an
  OpenAI product.
- **Codex** is a project/trademark of OpenAI.
- **DeepSeek Harness** is a project of DeepSeek AI; ideas from its
  architecture are credited in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  none of its code is vendored here.
- Every third-party dependency (including `upstream/codex` and any
  integrated provider such as Open Computer Use) is governed by its own
  license; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) and
  `CONTRIBUTING.md` before importing code from another project.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Chosen for compatibility
with `openai/codex`, which is also Apache-2.0.
