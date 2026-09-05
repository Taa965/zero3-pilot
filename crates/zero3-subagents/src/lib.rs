//! External Agent Collaboration adapters (legacy crate name: `zero3-subagents`).
//!
//! Codex / Claude / Hermes workers in this crate are **not** Zero3's primary
//! Agent Kernel. Zero3's authoritative core is the open-source Codex runtime.
//! These adapters exist so the Multi-Agent Collaboration module can instruct,
//! observe, continue, review, hand off to, or eventually take over work from
//! separately installed/running agent applications.
//!
//! The `Subagent*` API names are retained temporarily for compatibility. A
//! later migration will introduce an `ExternalAgent` contract with explicit
//! inspect / continue / handoff / takeover semantics.

pub mod registry;
pub mod workers;

pub use registry::SubagentRegistry;
