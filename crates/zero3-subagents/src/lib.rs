//! Subagent registry: one place to register Codex/Claude/Hermes (or any
//! future) workers behind the shared `zero3_core::subagent::SubagentWorker`
//! contract, and dispatch a task to one by name without the caller caring
//! which backend actually runs it.

pub mod registry;
pub mod workers;

pub use registry::SubagentRegistry;
