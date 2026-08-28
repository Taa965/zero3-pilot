//! Provider seams. Phase 1 deliberately did not reimplement Windows
//! Computer Use from scratch — see docs/ARCHITECTURE.md — and Phase 2
//! wires up to `iFurySt/open-codex-computer-use` behind the
//! `ComputerProvider` trait so the backend stays swappable
//! (OpenComputerUseAdapter -> native WindowsUIA -> vision fallback).
//!
//! `ProviderRegistry` (generic over the shared `Provider` contract) is how
//! callers register, health-check, and select providers by capability
//! without depending on a concrete backend.

pub mod browser;
pub mod computer;
pub mod open_computer_use;
pub mod provider;
pub mod registry;

pub use provider::Provider;
pub use registry::ProviderRegistry;
