//! Legacy external-agent dispatch abstraction.
//!
//! This module predates the Codex-core architecture reset. Implementations
//! such as installed Codex, Claude or Hermes clients belong to the optional
//! Multi-Agent Collaboration layer; they are not the primary Zero3 runtime.
//! The authoritative Agent Kernel is open-source Codex via its native core /
//! app-server protocol.
//!
//! `Subagent*` names remain temporarily for source compatibility. The planned
//! replacement is an `ExternalAgent` contract that can inspect active work,
//! continue tasks, observe progress, hand off work and support Zero3 takeover.

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
    /// External collaborator name, e.g. "claude", "codex", "hermes".
    fn name(&self) -> &str;

    async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult>;
}
