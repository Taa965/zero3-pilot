# Upstream strategy: openai/codex

Zero3 Pilot builds *on* Codex, not as a fork that diverges from it. This
document is the hard constraint every contributor (human or agent) checks
before touching anything that looks like Codex source.

## Remotes

```bash
git remote add upstream https://github.com/openai/codex.git
git fetch upstream
```

`origin` is `Taa965/zero3-pilot`. `upstream` is read-only tracking of
`openai/codex` — never push to it.

## How Codex code enters this repo

Codex's own source is not vendored into this repository's history. It is
pulled in as a **git submodule** at `upstream/codex`, pinned to a specific
commit:

```bash
git submodule add https://github.com/openai/codex.git upstream/codex
```

To check for upstream changes before bumping the pin:

```bash
git fetch upstream
git log upstream/main --oneline -20   # see what's new
cd upstream/codex && git fetch origin && git checkout <new-sha> && cd ../..
git add upstream/codex
git commit -m "chore(upstream): bump codex to <new-sha>"
```

This keeps `git fetch upstream` meaningful (tracks the canonical repo) while
keeping the actual pinned code an explicit, reviewable commit — never a
silent merge into Zero3 Pilot's own history.

## Merge/rebase policy

There is no merge or rebase of `upstream/main` into Zero3 Pilot's `main`.
Zero3 Pilot is a separate project that *depends on* Codex; it does not carry
Codex's commit history. Bumping the submodule pin is the only sync
mechanism.

## Where Zero3 extends vs. where it touches Core

- **Allowed, encouraged:** everything under `crates/`, `zero3/`, `apps/`,
  `mcp/`, `skills/` — these depend on Codex (via the submodule, through its
  published extension points: MCP, hooks, plugin config) but never patch it.
- **Requires justification, logged here:** any change inside
  `upstream/codex/` itself. None exist yet. If one becomes necessary:
  1. Explain here *why* no existing extension point (MCP, hook, config)
     covers it.
  2. Note the exact file/function touched.
  3. Note the upstream merge risk (does this file change often upstream?).
  4. Note whether it could become a hook/trait/plugin later instead, so the
     patch is temporary rather than permanent drift.
- **Never:** hard-coding Zero3-specific business logic into Codex Core to
  save an abstraction. If Codex lacks the extension point you need, that is
  itself the finding to record above — not a reason to patch around it
  silently.

## Current modification log

_None. `upstream/codex` is unmodified since it was pinned._
