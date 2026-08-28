//! Provider seams. Phase 1 deliberately does not reimplement Windows
//! Computer Use from scratch — see docs/ARCHITECTURE.md — it wires up to
//! `iFurySt/open-codex-computer-use` behind this trait so the backend stays
//! swappable (OpenComputerUse -> native WindowsUIA -> vision fallback).

pub mod browser;
pub mod computer;
