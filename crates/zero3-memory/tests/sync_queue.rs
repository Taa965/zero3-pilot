#[path = "../src/sync_queue.rs"]
mod sync_queue;

use serde_json::json;
use sync_queue::{PendingState, SqliteSyncQueue};

#[test]
fn offline_queue_can_ack_after_reconnect() {
    let queue = SqliteSyncQueue::open_in_memory().unwrap();
    queue
        .enqueue("evt-1", &json!({"schema":"zero3.memory.event.v1"}))
        .unwrap();
    queue.mark_sending(&["evt-1".into()]).unwrap();
    assert!(queue.mark_acked("evt-1", 42).unwrap());
    let item = queue.get_pending("evt-1").unwrap().unwrap();
    assert_eq!(item.state, PendingState::Acked);
    assert_eq!(item.server_sequence, Some(42));
}
