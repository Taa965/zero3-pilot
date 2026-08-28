//! Integration test: JobManager backed by the real, persistent
//! zero3-store::EventStore (not the in-memory test double used by the
//! unit tests) — proves P0-2's requirement end to end: create several
//! jobs across every terminal outcome, drop the manager (simulating a
//! process restart), reopen the same store file, and recover a fresh
//! manager whose JobRecords match the originals field-for-field — not
//! just event *counts*.

use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;
use zero3_core::job::JobStatus;
use zero3_scheduler::JobManager;
use zero3_store::EventStore;

#[test]
fn recovered_manager_matches_the_original_job_records_field_for_field() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.jsonl");

    let session = Uuid::new_v4();
    let succeeded_id;
    let failed_id;
    let cancelled_from_queued_id;
    let cancelled_from_running_id;
    let still_queued_id;
    let original_succeeded;
    let original_failed;
    let original_cancelled_from_queued;
    let original_cancelled_from_running;
    let original_still_queued;

    {
        let store = Arc::new(EventStore::open(&path).unwrap());
        let manager_a = JobManager::new(store);

        succeeded_id = manager_a
            .create("computer.click", json!({"x": 1, "y": 2}), Some(session))
            .unwrap();
        manager_a.start(succeeded_id).unwrap();
        manager_a.progress(succeeded_id, "clicked").unwrap();
        manager_a
            .complete(succeeded_id, json!({"ok": true, "pixels_moved": 12}))
            .unwrap();

        failed_id = manager_a
            .create(
                "browser.navigate",
                json!({"url": "https://example.com"}),
                Some(session),
            )
            .unwrap();
        manager_a.start(failed_id).unwrap();
        manager_a.fail(failed_id, "navigation timed out").unwrap();

        cancelled_from_queued_id = manager_a
            .create("subagent.dispatch", json!({}), None)
            .unwrap();
        manager_a.cancel(cancelled_from_queued_id).unwrap();

        cancelled_from_running_id = manager_a
            .create("shell.run", json!({"cmd": "sleep 1000"}), None)
            .unwrap();
        manager_a.start(cancelled_from_running_id).unwrap();
        manager_a.cancel(cancelled_from_running_id).unwrap();

        still_queued_id = manager_a
            .create("fs.scan", json!(["a", "b"]), None)
            .unwrap();

        original_succeeded = manager_a.get(succeeded_id).unwrap();
        original_failed = manager_a.get(failed_id).unwrap();
        original_cancelled_from_queued = manager_a.get(cancelled_from_queued_id).unwrap();
        original_cancelled_from_running = manager_a.get(cancelled_from_running_id).unwrap();
        original_still_queued = manager_a.get(still_queued_id).unwrap();

        // manager_a (and its Arc<EventStore> handle) drop here —
        // simulates the process exiting.
    }

    // Reopen the same file as a totally independent store/manager,
    // "manager B", and recover purely from the durable log.
    let reopened_store = Arc::new(EventStore::open(&path).unwrap());
    let manager_b = JobManager::recover(reopened_store).unwrap();

    for (id, original) in [
        (succeeded_id, &original_succeeded),
        (failed_id, &original_failed),
        (cancelled_from_queued_id, &original_cancelled_from_queued),
        (cancelled_from_running_id, &original_cancelled_from_running),
        (still_queued_id, &original_still_queued),
    ] {
        let recovered = manager_b
            .get(id)
            .unwrap_or_else(|| panic!("job {id} missing after recovery"));

        assert_eq!(recovered.id, original.id);
        assert_eq!(recovered.kind, original.kind, "kind mismatch for {id}");
        assert_eq!(
            recovered.payload, original.payload,
            "payload mismatch for {id}"
        );
        assert_eq!(
            recovered.status, original.status,
            "status mismatch for {id}"
        );
        assert_eq!(
            recovered.output, original.output,
            "output mismatch for {id}"
        );
        assert_eq!(recovered.error, original.error, "error mismatch for {id}");
        assert_eq!(
            recovered.session_id, original.session_id,
            "session_id mismatch for {id}"
        );
        assert_eq!(
            recovered.created_at, original.created_at,
            "created_at mismatch for {id}"
        );
        assert_eq!(
            recovered.updated_at, original.updated_at,
            "updated_at mismatch for {id}"
        );
    }

    // Sanity on the specific statuses/outputs this scenario is meant to cover.
    assert_eq!(manager_b.status(succeeded_id), Some(JobStatus::Succeeded));
    assert_eq!(
        manager_b.output(succeeded_id),
        Some(json!({"ok": true, "pixels_moved": 12}))
    );
    assert_eq!(manager_b.status(failed_id), Some(JobStatus::Failed));
    assert_eq!(
        manager_b.status(cancelled_from_queued_id),
        Some(JobStatus::Cancelled)
    );
    assert_eq!(
        manager_b.status(cancelled_from_running_id),
        Some(JobStatus::Cancelled)
    );
    assert_eq!(manager_b.status(still_queued_id), Some(JobStatus::Queued));

    assert_eq!(manager_b.list().len(), 5);

    // The recovered manager is fully live, not read-only: further
    // transitions append to the same durable log and behave normally.
    manager_b.start(still_queued_id).unwrap();
    assert_eq!(manager_b.status(still_queued_id), Some(JobStatus::Running));
}
