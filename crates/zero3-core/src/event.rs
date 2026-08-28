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
            EventKind::JobQueued { job_id, .. }
            | EventKind::JobStarted { job_id }
            | EventKind::JobProgress { job_id, .. }
            | EventKind::JobCompleted { job_id, .. }
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
    /// The event stream is the source of truth for job recovery, so this
    /// carries everything a `JobManager::recover` needs to reconstruct the
    /// job that doesn't come from the `Event` envelope itself
    /// (`session_id`, `at`) or from a later event (`output`, `error`).
    JobQueued {
        job_id: Uuid,
        kind: String,
        payload: serde_json::Value,
    },
    JobStarted {
        job_id: Uuid,
    },
    JobProgress {
        job_id: Uuid,
        message: String,
    },
    JobCompleted {
        job_id: Uuid,
        output: serde_json::Value,
    },
    JobFailed {
        job_id: Uuid,
        reason: String,
    },
    JobCancelled {
        job_id: Uuid,
    },
    ApprovalRequested {
        action: String,
        scope: String,
    },
    ApprovalGranted {
        action: String,
    },
    ApprovalDenied {
        action: String,
    },
    Log {
        level: LogLevel,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// A physically incomplete final record — the shape a crash mid-write
/// leaves behind — reported explicitly rather than silently dropped or
/// silently treated as if it never happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedTail {
    pub line: usize,
    pub raw: String,
    pub reason: String,
}

/// The result of a crash-tolerant replay: every event that parsed
/// cleanly, plus (only when the physical end of the log is an
/// incomplete/unterminated record) `truncated_tail` instead of a hard
/// failure. Corruption anywhere else in the log is never folded into
/// this — see `EventLog::replay_recoverable`.
#[derive(Debug)]
pub struct RecoverableReplay {
    pub events: Vec<Event>,
    pub truncated_tail: Option<TruncatedTail>,
}

/// Append-only sink for events. A first implementation can be a local JSONL
/// file; later ones (SQLite, remote control plane) satisfy the same trait.
///
/// `replay` is part of the contract, not an extra: a log a caller can't
/// read back (e.g. to rebuild `JobManager` state after a restart) isn't
/// serving as a real source of truth, just a write-only sink.
pub trait EventLog: Send + Sync {
    fn append(&self, event: Event) -> anyhow::Result<()>;

    /// Strict: any corrupt/incomplete record anywhere in the log
    /// (including a physically-unterminated last one) is fatal.
    fn replay(&self) -> anyhow::Result<Vec<Event>>;

    /// Tolerant of a *physically incomplete last record only* — i.e. a
    /// crash caught the writer mid-`write`. Corruption anywhere else is
    /// still always fatal, and the tail issue is surfaced via
    /// `truncated_tail`, never silently dropped.
    ///
    /// Default: delegates to the strict `replay()` and reports no tail
    /// issue — a log implementation that can't actually distinguish "torn
    /// tail" from "real corruption" (or that's inherently atomic, e.g. a
    /// transactional store) has nothing meaningful to add here. Override
    /// this only when the implementation can make that distinction for
    /// real, as `zero3-store::EventStore` does.
    fn replay_recoverable(&self) -> anyhow::Result<RecoverableReplay> {
        Ok(RecoverableReplay {
            events: self.replay()?,
            truncated_tail: None,
        })
    }
}
