//! Integration test: JobManager backed by the real, persistent
//! zero3-store::EventStore (not the in-memory test double used by the
//! unit tests) — proves job history survives a process restart and that
//! replay can reconstruct which events belonged to which job/session.

use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;
use zero3_core::event::EventKind;
use zero3_scheduler::JobManager;
use zero3_store::EventStore;

#[test]
fn job_history_is_durable_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.jsonl");
    let session = Uuid::new_v4();
    let job_id;

    {
        let store = Arc::new(EventStore::open(&path).unwrap());
        let manager = JobManager::new(store);
        job_id = manager
            .create("computer.click", json!({"x": 1, "y": 2}), Some(session))
            .unwrap();
        manager.start(job_id).unwrap();
        manager.progress(job_id, "clicked").unwrap();
        manager.complete(job_id, json!({"ok": true})).unwrap();
        // manager and its Arc<EventStore> drop here — simulates the
        // process exiting after the job finished.
    }

    // A fresh store re-opened against the same file sees the full history.
    let reopened = EventStore::open(&path).unwrap();
    let job_events = reopened.replay_job(job_id).unwrap();
    assert_eq!(job_events.len(), 4, "queued, started, progress, completed");

    let session_events = reopened.replay_session(session).unwrap();
    assert_eq!(session_events.len(), 4);

    // A brand new in-memory JobManager doesn't know about the old job
    // (v1 doesn't rebuild its index from replay yet — this documents that
    // boundary rather than assuming it), but the durable log does, and
    // the log's last event for this job confirms it finished successfully.
    let store = Arc::new(EventStore::open(&path).unwrap());
    let fresh_manager = JobManager::new(store);
    assert_eq!(fresh_manager.status(job_id), None);
    assert!(matches!(
        job_events.last().unwrap().kind,
        EventKind::JobCompleted { job_id: completed_id } if completed_id == job_id
    ));
}
