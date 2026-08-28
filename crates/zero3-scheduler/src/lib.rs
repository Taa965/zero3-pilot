//! Job Manager v1: create/list/status/output/cancel over the
//! queued -> running -> {succeeded, failed} state machine from
//! `zero3_core::job::JobStatus` (queued/running can also go to
//! cancelled), with every transition durably logged through an injected
//! `zero3_core::event::EventLog` (typically `zero3-store::EventStore`)
//! for session/job correlation, replay, and crash recovery.
//!
//! **Durable-first invariant**: every method here appends the event
//! *before* touching in-memory state, and only mutates the `JobRecord`
//! after `EventLog::append` returns `Ok`. If the log write fails, the
//! in-memory `status`/`output`/`error`/`updated_at` are left exactly as
//! they were — never advanced on a write that didn't durably land. This
//! is enforced under the same lock acquisition (see each method), so
//! there's no window where a concurrent reader could observe a state
//! change that later turns out not to have been logged.
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

    /// Rebuilds a `JobManager` entirely from a durable log's history —
    /// `EventStore::replay()` (or any other `EventLog::replay()`) is the
    /// source of truth, not a cache in front of one.
    pub fn recover(event_log: Arc<dyn EventLog>) -> Result<Self, JobManagerError> {
        let events = event_log.replay().map_err(JobManagerError::EventLog)?;
        Ok(Self::from_events(&events, event_log))
    }

    /// Pure reconstruction from an already-replayed event slice. Events
    /// referencing a job with no prior `JobQueued` (a truncated/partial
    /// log) are skipped rather than panicking or fabricating a record —
    /// there's nothing to recover `kind`/`payload` from.
    pub fn from_events(events: &[Event], event_log: Arc<dyn EventLog>) -> Self {
        let mut jobs: HashMap<Uuid, JobRecord> = HashMap::new();
        for event in events {
            match &event.kind {
                EventKind::JobQueued {
                    job_id,
                    kind,
                    payload,
                } => {
                    jobs.insert(
                        *job_id,
                        JobRecord {
                            id: *job_id,
                            kind: kind.clone(),
                            payload: payload.clone(),
                            status: JobStatus::Queued,
                            output: None,
                            error: None,
                            session_id: event.session_id,
                            created_at: event.at,
                            updated_at: event.at,
                        },
                    );
                }
                EventKind::JobStarted { job_id } => {
                    if let Some(record) = jobs.get_mut(job_id) {
                        record.status = JobStatus::Running;
                        record.updated_at = event.at;
                    }
                }
                EventKind::JobProgress { .. } => {
                    // Doesn't affect JobRecord fields we track (matches
                    // JobManager::progress, which doesn't bump updated_at
                    // either) — replayed for completeness of the log, not
                    // for state reconstruction.
                }
                EventKind::JobCompleted { job_id, output } => {
                    if let Some(record) = jobs.get_mut(job_id) {
                        record.status = JobStatus::Succeeded;
                        record.output = Some(output.clone());
                        record.updated_at = event.at;
                    }
                }
                EventKind::JobFailed { job_id, reason } => {
                    if let Some(record) = jobs.get_mut(job_id) {
                        record.status = JobStatus::Failed;
                        record.error = Some(reason.clone());
                        record.updated_at = event.at;
                    }
                }
                EventKind::JobCancelled { job_id } => {
                    if let Some(record) = jobs.get_mut(job_id) {
                        record.status = JobStatus::Cancelled;
                        record.updated_at = event.at;
                    }
                }
                _ => {}
            }
        }
        Self {
            jobs: Mutex::new(jobs),
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
        let kind = kind.into();

        // Durable-first: nothing is inserted into `jobs` unless the
        // creation event lands first.
        let at = self.append_event(
            session_id,
            EventKind::JobQueued {
                job_id: id,
                kind: kind.clone(),
                payload: payload.clone(),
            },
        )?;

        let record = JobRecord {
            id,
            kind,
            payload,
            status: JobStatus::Queued,
            output: None,
            error: None,
            session_id,
            created_at: at,
            updated_at: at,
        };
        self.jobs.lock().unwrap().insert(id, record);
        Ok(id)
    }

    pub fn start(&self, id: Uuid) -> Result<(), JobManagerError> {
        let mut jobs = self.jobs.lock().unwrap();
        let record = jobs.get(&id).ok_or(JobManagerError::NotFound(id))?;
        Self::require_status(record, &[JobStatus::Queued], JobStatus::Running)?;
        let session_id = record.session_id;

        // Append while still holding the lock: no other call can observe
        // (or race to advance) this job's state between validation and
        // the durable write landing.
        let at = self.append_event(session_id, EventKind::JobStarted { job_id: id })?;

        let record = jobs
            .get_mut(&id)
            .expect("checked above, lock held throughout");
        record.status = JobStatus::Running;
        record.updated_at = at;
        Ok(())
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
        self.append_event(
            session_id,
            EventKind::JobProgress {
                job_id: id,
                message: message.into(),
            },
        )
        .map(|_at| ())
    }

    pub fn complete(&self, id: Uuid, output: Value) -> Result<(), JobManagerError> {
        let mut jobs = self.jobs.lock().unwrap();
        let record = jobs.get(&id).ok_or(JobManagerError::NotFound(id))?;
        Self::require_status(record, &[JobStatus::Running], JobStatus::Succeeded)?;
        let session_id = record.session_id;

        let at = self.append_event(
            session_id,
            EventKind::JobCompleted {
                job_id: id,
                output: output.clone(),
            },
        )?;

        let record = jobs
            .get_mut(&id)
            .expect("checked above, lock held throughout");
        record.status = JobStatus::Succeeded;
        record.output = Some(output);
        record.updated_at = at;
        Ok(())
    }

    pub fn fail(&self, id: Uuid, reason: impl Into<String>) -> Result<(), JobManagerError> {
        let reason = reason.into();
        let mut jobs = self.jobs.lock().unwrap();
        let record = jobs.get(&id).ok_or(JobManagerError::NotFound(id))?;
        Self::require_status(record, &[JobStatus::Running], JobStatus::Failed)?;
        let session_id = record.session_id;

        let at = self.append_event(
            session_id,
            EventKind::JobFailed {
                job_id: id,
                reason: reason.clone(),
            },
        )?;

        let record = jobs
            .get_mut(&id)
            .expect("checked above, lock held throughout");
        record.status = JobStatus::Failed;
        record.error = Some(reason);
        record.updated_at = at;
        Ok(())
    }

    /// Only queued or running jobs can be cancelled — a terminal job
    /// (succeeded/failed/already cancelled) rejects this rather than
    /// silently accepting it, so callers can't paper over a job that
    /// already finished.
    pub fn cancel(&self, id: Uuid) -> Result<(), JobManagerError> {
        let mut jobs = self.jobs.lock().unwrap();
        let record = jobs.get(&id).ok_or(JobManagerError::NotFound(id))?;
        Self::require_status(
            record,
            &[JobStatus::Queued, JobStatus::Running],
            JobStatus::Cancelled,
        )?;
        let session_id = record.session_id;

        let at = self.append_event(session_id, EventKind::JobCancelled { job_id: id })?;

        let record = jobs
            .get_mut(&id)
            .expect("checked above, lock held throughout");
        record.status = JobStatus::Cancelled;
        record.updated_at = at;
        Ok(())
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

    fn require_status(
        record: &JobRecord,
        allowed: &[JobStatus],
        to: JobStatus,
    ) -> Result<(), JobManagerError> {
        if allowed.contains(&record.status) {
            Ok(())
        } else {
            Err(JobManagerError::InvalidTransition {
                job_id: record.id,
                from: record.status,
                to,
            })
        }
    }

    /// Appends the event and returns the timestamp it was stamped with —
    /// callers use that same instant for `JobRecord.created_at`/
    /// `updated_at` rather than taking a second, separate `Utc::now()`
    /// reading, so a record built live and one rebuilt via
    /// `from_events`/`recover` (which uses `Event.at`) always agree to
    /// the nanosecond instead of merely being "close".
    fn append_event(
        &self,
        session_id: Option<Uuid>,
        kind: EventKind,
    ) -> Result<DateTime<Utc>, JobManagerError> {
        let mut event = Event::new(EventSource::Scheduler, kind);
        let at = event.at;
        if let Some(s) = session_id {
            event = event.with_session(s);
        }
        self.event_log
            .append(event)
            .map_err(JobManagerError::EventLog)?;
        Ok(at)
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

        fn replay(&self) -> anyhow::Result<Vec<Event>> {
            Ok(self.events.lock().unwrap().clone())
        }
    }

    /// Fails every `append` call — used to prove the durable-first
    /// invariant: in-memory state must never advance when the log write
    /// fails.
    #[derive(Default)]
    struct FailingEventLog;

    impl EventLog for FailingEventLog {
        fn append(&self, _event: Event) -> anyhow::Result<()> {
            anyhow::bail!("simulated durable-log failure")
        }

        fn replay(&self) -> anyhow::Result<Vec<Event>> {
            Ok(Vec::new())
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

    // --- P0-1: durable-first failure-injection tests --------------------
    //
    // Each of these proves that when EventLog::append fails, in-memory
    // state does not advance: status/output/error/updated_at are exactly
    // as they were before the call.

    #[test]
    fn create_never_inserts_a_record_when_the_log_write_fails() {
        let mgr = JobManager::new(Arc::new(FailingEventLog));
        let err = mgr.create("k", json!({}), None).unwrap_err();
        assert!(matches!(err, JobManagerError::EventLog(_)));
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn start_does_not_advance_status_when_the_log_write_fails() {
        let log = Arc::new(InMemoryEventLog::default());
        let mgr = JobManager::new(log.clone());
        let id = mgr.create("k", json!({}), None).unwrap();
        let before = mgr.get(id).unwrap();

        // Swap in a failing log for the transition under test by building
        // a second manager sharing the same in-memory job... instead,
        // simplest: construct a manager whose log always fails and seed
        // it via from_events so the job pre-exists as Queued.
        let queued_event = log.events.lock().unwrap().clone();
        let failing_mgr = JobManager::from_events(&queued_event, Arc::new(FailingEventLog));

        let err = failing_mgr.start(id).unwrap_err();
        assert!(matches!(err, JobManagerError::EventLog(_)));

        let after = failing_mgr.get(id).unwrap();
        assert_eq!(after.status, before.status);
        assert_eq!(after.status, JobStatus::Queued);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(after.output, before.output);
        assert_eq!(after.error, before.error);
    }

    #[test]
    fn complete_does_not_advance_status_or_output_when_the_log_write_fails() {
        let log = Arc::new(InMemoryEventLog::default());
        let seed_mgr = JobManager::new(log.clone());
        let id = seed_mgr.create("k", json!({}), None).unwrap();
        seed_mgr.start(id).unwrap();

        let events = log.events.lock().unwrap().clone();
        let failing_mgr = JobManager::from_events(&events, Arc::new(FailingEventLog));
        let before = failing_mgr.get(id).unwrap();
        assert_eq!(before.status, JobStatus::Running);

        let err = failing_mgr
            .complete(id, json!({"should": "not persist"}))
            .unwrap_err();
        assert!(matches!(err, JobManagerError::EventLog(_)));

        let after = failing_mgr.get(id).unwrap();
        assert_eq!(after.status, JobStatus::Running, "status must not advance");
        assert_eq!(after.output, None, "output must not be set");
        assert_eq!(
            after.updated_at, before.updated_at,
            "updated_at must not change"
        );
    }

    #[test]
    fn fail_does_not_advance_status_or_error_when_the_log_write_fails() {
        let log = Arc::new(InMemoryEventLog::default());
        let seed_mgr = JobManager::new(log.clone());
        let id = seed_mgr.create("k", json!({}), None).unwrap();
        seed_mgr.start(id).unwrap();

        let events = log.events.lock().unwrap().clone();
        let failing_mgr = JobManager::from_events(&events, Arc::new(FailingEventLog));
        let before = failing_mgr.get(id).unwrap();

        let err = failing_mgr.fail(id, "should not persist").unwrap_err();
        assert!(matches!(err, JobManagerError::EventLog(_)));

        let after = failing_mgr.get(id).unwrap();
        assert_eq!(after.status, JobStatus::Running, "status must not advance");
        assert_eq!(after.error, None, "error must not be set");
        assert_eq!(after.updated_at, before.updated_at);
    }

    #[test]
    fn cancel_does_not_advance_status_when_the_log_write_fails_from_queued_or_running() {
        for start_first in [false, true] {
            let log = Arc::new(InMemoryEventLog::default());
            let seed_mgr = JobManager::new(log.clone());
            let id = seed_mgr.create("k", json!({}), None).unwrap();
            if start_first {
                seed_mgr.start(id).unwrap();
            }

            let events = log.events.lock().unwrap().clone();
            let failing_mgr = JobManager::from_events(&events, Arc::new(FailingEventLog));
            let before = failing_mgr.get(id).unwrap();
            let expected_status = if start_first {
                JobStatus::Running
            } else {
                JobStatus::Queued
            };
            assert_eq!(before.status, expected_status);

            let err = failing_mgr.cancel(id).unwrap_err();
            assert!(matches!(err, JobManagerError::EventLog(_)));

            let after = failing_mgr.get(id).unwrap();
            assert_eq!(
                after.status, expected_status,
                "status must not advance to Cancelled"
            );
            assert_eq!(after.updated_at, before.updated_at);
        }
    }

    // --- P0-2: recovery from a replayed event log ------------------------

    #[test]
    fn from_events_reconstructs_every_tracked_field() {
        let log = Arc::new(InMemoryEventLog::default());
        let mgr = JobManager::new(log.clone());
        let session = Uuid::new_v4();

        let succeeded = mgr
            .create("computer.click", json!({"x": 1, "y": 2}), Some(session))
            .unwrap();
        mgr.start(succeeded).unwrap();
        mgr.complete(succeeded, json!({"ok": true})).unwrap();

        let failed = mgr
            .create("browser.nav", json!({"url": "x"}), None)
            .unwrap();
        mgr.start(failed).unwrap();
        mgr.fail(failed, "boom").unwrap();

        let cancelled = mgr.create("k", json!({}), None).unwrap();
        mgr.cancel(cancelled).unwrap();

        let still_queued = mgr.create("k2", json!("payload"), None).unwrap();

        let events = log.replay().unwrap();
        let recovered = JobManager::from_events(&events, Arc::new(InMemoryEventLog::default()));

        let a = recovered.get(succeeded).unwrap();
        assert_eq!(a.kind, "computer.click");
        assert_eq!(a.payload, json!({"x": 1, "y": 2}));
        assert_eq!(a.status, JobStatus::Succeeded);
        assert_eq!(a.output, Some(json!({"ok": true})));
        assert_eq!(a.error, None);
        assert_eq!(a.session_id, Some(session));

        let b = recovered.get(failed).unwrap();
        assert_eq!(b.kind, "browser.nav");
        assert_eq!(b.status, JobStatus::Failed);
        assert_eq!(b.error.as_deref(), Some("boom"));
        assert_eq!(b.output, None);

        let c = recovered.get(cancelled).unwrap();
        assert_eq!(c.status, JobStatus::Cancelled);

        let d = recovered.get(still_queued).unwrap();
        assert_eq!(d.status, JobStatus::Queued);
        assert_eq!(d.payload, json!("payload"));

        assert_eq!(recovered.list().len(), 4);
    }

    #[test]
    fn recover_reads_through_the_injected_event_log() {
        let log = Arc::new(InMemoryEventLog::default());
        let mgr = JobManager::new(log.clone());
        let id = mgr.create("k", json!({"n": 1}), None).unwrap();
        mgr.start(id).unwrap();

        let recovered = JobManager::recover(log).unwrap();
        let record = recovered.get(id).unwrap();
        assert_eq!(record.status, JobStatus::Running);
        assert_eq!(record.payload, json!({"n": 1}));
    }

    #[test]
    fn orphan_transition_events_without_a_prior_queued_are_skipped_not_panicking() {
        let orphan_id = Uuid::new_v4();
        let events = vec![Event::new(
            EventSource::Scheduler,
            EventKind::JobStarted { job_id: orphan_id },
        )];
        let recovered = JobManager::from_events(&events, Arc::new(InMemoryEventLog::default()));
        assert_eq!(recovered.status(orphan_id), None);
        assert!(recovered.list().is_empty());
    }
}
