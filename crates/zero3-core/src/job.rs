//! Background job abstraction: long-running work the scheduler tracks and
//! the user can inspect, independent of which provider executes it.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSpec {
    pub id: Uuid,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[async_trait]
pub trait JobRunner: Send + Sync {
    /// The job kind this runner claims, e.g. "computer.click", "browser.nav".
    fn kind(&self) -> &str;

    async fn run(&self, spec: &JobSpec) -> anyhow::Result<serde_json::Value>;
}
