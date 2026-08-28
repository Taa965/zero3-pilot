# zero3/

Conceptual module map for Zero3 Pilot's extension surface. Actual Rust code
lives in `crates/*` and `apps/*` (Cargo workspace conventions put publishable
units there); each folder below is a short pointer to where that module's
code and design notes actually live, kept stable so the map in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) doesn't drift from the tree.

| Module | Status | Lives in |
|---|---|---|
| `events` | seam defined | [`crates/zero3-core/src/event.rs`](../crates/zero3-core/src/event.rs) |
| `subagent` | seam defined | [`crates/zero3-core/src/subagent.rs`](../crates/zero3-core/src/subagent.rs) |
| `plugins` | seam defined | [`crates/zero3-core/src/plugin.rs`](../crates/zero3-core/src/plugin.rs) |
| `scheduler` | in-memory placeholder | [`crates/zero3-scheduler`](../crates/zero3-scheduler) |
| `memory` | trait-only placeholder | [`crates/zero3-memory`](../crates/zero3-memory) |
| `providers` (computer/browser) | seam + unimplemented stub | [`crates/zero3-providers`](../crates/zero3-providers) |
| `computer` | not yet integrated — see `docs/ARCHITECTURE.md` §Computer Use | [`crates/zero3-providers/src/computer.rs`](../crates/zero3-providers/src/computer.rs) |
| `browser` | not yet integrated | [`crates/zero3-providers/src/browser.rs`](../crates/zero3-providers/src/browser.rs) |
| `automation` | not started | — |

Nothing under `zero3/` links against `upstream/codex` directly; all of it
talks to Codex Core (if at all) through an extension point documented in
[`docs/UPSTREAM.md`](../docs/UPSTREAM.md).
