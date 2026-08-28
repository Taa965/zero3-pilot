//! Subagent abstraction: dispatch a scoped task to a worker (Claude, Codex,
//! Hermes, ...) and get a typed result back, independent of which backend
//! executed it.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentTask {
    pub goal: String,
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentResult {
    pub summary: String,
    pub output: serde_json::Value,
}

#[async_trait]
pub trait SubagentWorker: Send + Sync {
    /// e.g. "claude", "codex", "hermes"
    fn name(&self) -> &str;

    async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult>;
}
