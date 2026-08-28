//! Job Manager v1: create/list/status/output/cancel over the
//! queued -> running -> {succeeded, failed, cancelled} state machine from
//! `zero3_core::job::JobStatus`, with every transition durably logged
//! through an injected `zero3_core::event::EventLog` (typically
//! `zero3-store::EventStore`) for session/job correlation and replay.
//!
//! State is enforced, not advisory: an invalid transition (e.g.
//! cancelling an already-succeeded job) is rejected with
//! `JobManagerError::InvalidTransition`, never silently accepted.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use zero3_core::event::{Event, EventKind, EventLog, EventSource};
use zero3_core::job::JobStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub status: JobStatus,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub session_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum JobManagerError {
    #[error("job {0} not found")]
    NotFound(Uuid),
    #[error("job {job_id} is {from:?}, cannot transition to {to:?}")]
    InvalidTransition {
        job_id: Uuid,
        from: JobStatus,
        to: JobStatus,
    },
    #[error("failed to record job event: {0}")]
    EventLog(#[source] anyhow::Error),
}

pub struct JobManager {
    jobs: Mutex<HashMap<Uuid, JobRecord>>,
    event_log: Arc<dyn EventLog>,
}

impl JobManager {
    pub fn new(event_log: Arc<dyn EventLog>) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            event_log,
        }
    }

    pub fn create(
        &self,
        kind: impl Into<String>,
        payload: Value,
        session_id: Option<Uuid>,
    ) -> Result<Uuid, JobManagerError> {
        let id = Uuid::new_v4();
        self.record_event(session_id, EventKind::JobQueued { job_id: id })?;

        let now = Utc::now();
        let record = JobRecord {
            id,
            kind: kind.into(),
            payload,
            status: JobStatus::Queued,
            output: None,
            error: None,
            session_id,
            created_at: now,
            updated_at: now,
        };
        self.jobs.lock().unwrap().insert(id, record);
        Ok(id)
    }

    pub fn start(&self, id: Uuid) -> Result<(), JobManagerError> {
        let session_id = self.transition(id, JobStatus::Running, &[JobStatus::Queued])?;
        self.record_event(session_id, EventKind::JobStarted { job_id: id })
    }

    pub fn progress(&self, id: Uuid, message: impl Into<String>) -> Result<(), JobManagerError> {
        let session_id = {
            let jobs = self.jobs.lock().unwrap();
            let record = jobs.get(&id).ok_or(JobManagerError::NotFound(id))?;
            if record.status != JobStatus::Running {
                return Err(JobManagerError::InvalidTransition {
                    job_id: id,
                    from: record.status,
                    to: JobStatus::Running,
                });
            }
            record.session_id
        };
        self.record_event(
            session_id,
            EventKind::JobProgress {
                job_id: id,
                message: message.into(),
            },
        )
    }

    pub fn complete(&self, id: Uuid, output: Value) -> Result<(), JobManagerError> {
        let session_id = self.transition(id, JobStatus::Succeeded, &[JobStatus::Running])?;
        self.record_event(session_id, EventKind::JobCompleted { job_id: id })?;
        if let Some(record) = self.jobs.lock().unwrap().get_mut(&id) {
            record.output = Some(output);
        }
        Ok(())
    }

    pub fn fail(&self, id: Uuid, reason: impl Into<String>) -> Result<(), JobManagerError> {
        let reason = reason.into();
        let session_id = self.transition(id, JobStatus::Failed, &[JobStatus::Running])?;
        self.record_event(
            session_id,
            EventKind::JobFailed {
                job_id: id,
                reason: reason.clone(),
            },
        )?;
        if let Some(record) = self.jobs.lock().unwrap().get_mut(&id) {
            record.error = Some(reason);
        }
        Ok(())
    }

    /// Only queued or running jobs can be cancelled — a terminal job
    /// (succeeded/failed/already cancelled) rejects this rather than
    /// silently accepting it, so callers can't paper over a job that
    /// already finished.
    pub fn cancel(&self, id: Uuid) -> Result<(), JobManagerError> {
        let session_id = self.transition(
            id,
            JobStatus::Cancelled,
            &[JobStatus::Queued, JobStatus::Running],
        )?;
        self.record_event(session_id, EventKind::JobCancelled { job_id: id })
    }

    pub fn status(&self, id: Uuid) -> Option<JobStatus> {
        self.jobs.lock().unwrap().get(&id).map(|r| r.status)
    }

    pub fn output(&self, id: Uuid) -> Option<Value> {
        self.jobs
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|r| r.output.clone())
    }

    pub fn get(&self, id: Uuid) -> Option<JobRecord> {
        self.jobs.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self) -> Vec<JobRecord> {
        let mut jobs: Vec<JobRecord> = self.jobs.lock().unwrap().values().cloned().collect();
        jobs.sort_by_key(|j| j.created_at);
        jobs
    }

    fn transition(
        &self,
        id: Uuid,
        to: JobStatus,
        allowed_from: &[JobStatus],
    ) -> Result<Option<Uuid>, JobManagerError> {
        let mut jobs = self.jobs.lock().unwrap();
        let record = jobs.get_mut(&id).ok_or(JobManagerError::NotFound(id))?;
        if !allowed_from.contains(&record.status) {
            return Err(JobManagerError::InvalidTransition {
                job_id: id,
                from: record.status,
                to,
            });
        }
        record.status = to;
        record.updated_at = Utc::now();
        Ok(record.session_id)
    }

    fn record_event(
        &self,
        session_id: Option<Uuid>,
        kind: EventKind,
    ) -> Result<(), JobManagerError> {
        let mut event = Event::new(EventSource::Scheduler, kind);
        if let Some(s) = session_id {
            event = event.with_session(s);
        }
        self.event_log
            .append(event)
            .map_err(JobManagerError::EventLog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct InMemoryEventLog {
        events: StdMutex<Vec<Event>>,
    }

    impl EventLog for InMemoryEventLog {
        fn append(&self, event: Event) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(event);
            Ok(())
        }
    }

    fn manager() -> (JobManager, Arc<InMemoryEventLog>) {
        let log = Arc::new(InMemoryEventLog::default());
        (JobManager::new(log.clone()), log)
    }

    #[test]
    fn happy_path_queued_running_succeeded() {
        let (mgr, log) = manager();
        let id = mgr.create("test.echo", json!({"a": 1}), None).unwrap();
        assert_eq!(mgr.status(id), Some(JobStatus::Queued));

        mgr.start(id).unwrap();
        assert_eq!(mgr.status(id), Some(JobStatus::Running));

        mgr.progress(id, "halfway").unwrap();

        mgr.complete(id, json!({"result": 42})).unwrap();
        assert_eq!(mgr.status(id), Some(JobStatus::Succeeded));
        assert_eq!(mgr.output(id), Some(json!({"result": 42})));

        // queued, started, progress, completed
        assert_eq!(log.events.lock().unwrap().len(), 4);
    }

    #[test]
    fn failed_path_records_reason() {
        let (mgr, _log) = manager();
        let id = mgr.create("test.echo", json!({}), None).unwrap();
        mgr.start(id).unwrap();
        mgr.fail(id, "boom").unwrap();
        assert_eq!(mgr.status(id), Some(JobStatus::Failed));
        assert_eq!(mgr.get(id).unwrap().error.as_deref(), Some("boom"));
    }

    #[test]
    fn cancel_from_queued_and_running_both_allowed() {
        let (mgr, _log) = manager();
        let queued = mgr.create("k", json!({}), None).unwrap();
        mgr.cancel(queued).unwrap();
        assert_eq!(mgr.status(queued), Some(JobStatus::Cancelled));

        let running = mgr.create("k", json!({}), None).unwrap();
        mgr.start(running).unwrap();
        mgr.cancel(running).unwrap();
        assert_eq!(mgr.status(running), Some(JobStatus::Cancelled));
    }

    #[test]
    fn cannot_cancel_a_terminal_job() {
        let (mgr, _log) = manager();
        let id = mgr.create("k", json!({}), None).unwrap();
        mgr.start(id).unwrap();
        mgr.complete(id, json!(null)).unwrap();

        let err = mgr.cancel(id).unwrap_err();
        assert!(matches!(
            err,
            JobManagerError::InvalidTransition {
                from: JobStatus::Succeeded,
                to: JobStatus::Cancelled,
                ..
            }
        ));
        // status must be unchanged by the rejected transition
        assert_eq!(mgr.status(id), Some(JobStatus::Succeeded));
    }

    #[test]
    fn cannot_start_a_job_twice() {
        let (mgr, _log) = manager();
        let id = mgr.create("k", json!({}), None).unwrap();
        mgr.start(id).unwrap();
        let err = mgr.start(id).unwrap_err();
        assert!(matches!(err, JobManagerError::InvalidTransition { .. }));
    }

    #[test]
    fn operations_on_unknown_job_id_fail_cleanly() {
        let (mgr, _log) = manager();
        let ghost = Uuid::new_v4();
        assert_eq!(mgr.status(ghost), None);
        assert!(matches!(
            mgr.start(ghost),
            Err(JobManagerError::NotFound(_))
        ));
        assert!(matches!(
            mgr.cancel(ghost),
            Err(JobManagerError::NotFound(_))
        ));
    }

    #[test]
    fn list_is_sorted_by_creation_order() {
        let (mgr, _log) = manager();
        let a = mgr.create("a", json!({}), None).unwrap();
        let b = mgr.create("b", json!({}), None).unwrap();
        let ids: Vec<Uuid> = mgr.list().into_iter().map(|j| j.id).collect();
        assert_eq!(ids, vec![a, b]);
    }

    #[test]
    fn session_id_flows_through_to_every_event() {
        let (mgr, log) = manager();
        let session = Uuid::new_v4();
        let id = mgr.create("k", json!({}), Some(session)).unwrap();
        mgr.start(id).unwrap();
        mgr.complete(id, json!(null)).unwrap();

        let events = log.events.lock().unwrap();
        assert!(events.iter().all(|e| e.session_id == Some(session)));
        assert!(events.iter().all(|e| e.job_id() == Some(id)));
    }
}
