#!/usr/bin/env bash
# Local pre-push check: mirrors what .github/workflows/ci.yml runs.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo fmt --all -- --check
cargo build --workspace --all-targets
cargo test --workspace
