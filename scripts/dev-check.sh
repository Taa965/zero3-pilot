#!/usr/bin/env bash
# Local core pre-push gate. This mirrors the repository-level Linux CI checks
# that are practical to run from a normal development checkout. Specialized
# Windows/Codex/feature smokes remain authoritative in GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-architecture.mjs
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --all-targets
cargo test --workspace
