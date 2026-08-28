//! zero3-core: the shared vocabulary every Zero3 Pilot extension speaks.
//!
//! This crate intentionally has no dependency on `upstream/codex`. It defines
//! the seams (traits + data types) that providers, plugins, subagents and the
//! scheduler are built against, so Codex Core stays untouched and swappable.

pub mod event;
pub mod job;
pub mod permission;
pub mod plugin;
pub mod subagent;
