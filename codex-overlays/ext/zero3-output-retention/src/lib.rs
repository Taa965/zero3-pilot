//! Zero3 full-output retention for the pinned Codex kernel.
//!
//! The extension keeps Codex as the sole execution authority. It stores an
//! exact copy of oversized plain-text tool output and exposes only a bounded
//! model projection plus an opaque locator. Approval, sandboxing, and the tool
//! execution result itself remain owned by Codex.

mod extension;
mod projection;
mod retention;
mod store;
mod tools;

pub use extension::OutputRetentionConfig;
pub use extension::OutputRetentionExtension;
pub use extension::install;
pub use retention::RetentionOutcome;
pub use retention::retain_text;
pub use store::LocalSpillStore;
pub use store::SpillFuture;
pub use store::SpillRef;
pub use store::SpillSource;
pub use store::SpillStore;
pub use tools::GREP_SPILL_TOOL_NAME;
pub use tools::READ_SPILL_TOOL_NAME;
