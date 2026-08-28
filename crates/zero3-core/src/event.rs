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
    /// Correlates events belonging to the same session (a conversation, a
    /// CI run, a remote-control connection — whatever the caller treats as
    /// one unit of work spanning multiple events). Orthogonal to
    /// `job_id()`: a session can contain many jobs.
    pub session_id: Option<Uuid>,
    pub kind: EventKind,
}

impl Event {
    pub fn new(source: EventSource, kind: EventKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            at: Utc::now(),
            source,
            session_id: None,
            kind,
        }
    }

    pub fn with_session(mut self, session_id: Uuid) -> Self {
        self.session_id = Some(session_id);
        self
    }

    /// The job this event pertains to, if any — pulled out of `kind` so
    /// callers (e.g. an event store's replay-by-job filter) don't need to
    /// match on every `EventKind::Job*` variant themselves.
    pub fn job_id(&self) -> Option<Uuid> {
        match &self.kind {
            EventKind::JobQueued { job_id }
            | EventKind::JobStarted { job_id }
            | EventKind::JobProgress { job_id, .. }
            | EventKind::JobCompleted { job_id }
            | EventKind::JobFailed { job_id, .. }
            | EventKind::JobCancelled { job_id } => Some(*job_id),
            _ => None,
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
    JobQueued { job_id: Uuid },
    JobStarted { job_id: Uuid },
    JobProgress { job_id: Uuid, message: String },
    JobCompleted { job_id: Uuid },
    JobFailed { job_id: Uuid, reason: String },
    JobCancelled { job_id: Uuid },
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
