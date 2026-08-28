//! Session event model shared by the event log, scheduler, and subagents.
//!
//! Loosely inspired by DeepSeek Harness's "everything is an event" session
//! model, re-expressed as a plain Rust enum instead of a Node/Cordis runtime.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: Uuid,
    pub at: DateTime<Utc>,
    pub source: EventSource,
    pub kind: EventKind,
}

impl Event {
    pub fn new(source: EventSource, kind: EventKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            at: Utc::now(),
            source,
            kind,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EventSource {
    User,
    Agent { name: String },
    Subagent { parent: String, name: String },
    Plugin { id: String },
    Scheduler,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EventKind {
    JobStarted { job_id: Uuid },
    JobProgress { job_id: Uuid, message: String },
    JobCompleted { job_id: Uuid },
    JobFailed { job_id: Uuid, reason: String },
    ApprovalRequested { action: String, scope: String },
    ApprovalGranted { action: String },
    ApprovalDenied { action: String },
    Log { level: LogLevel, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Append-only sink for events. A first implementation can be a local JSONL
/// file; later ones (SQLite, remote control plane) satisfy the same trait.
pub trait EventLog: Send + Sync {
    fn append(&self, event: Event) -> anyhow::Result<()>;
}
