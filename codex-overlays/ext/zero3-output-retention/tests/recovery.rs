use codex_zero3_output_retention::LocalSpillStore;
use codex_zero3_output_retention::RetentionOutcome;
use codex_zero3_output_retention::SpillSource;
use codex_zero3_output_retention::SpillStore;
use codex_zero3_output_retention::retain_text;

fn source() -> SpillSource {
    SpillSource {
        thread_id: "parent-thread".to_string(),
        turn_id: "turn-1".to_string(),
        call_id: "call-1".to_string(),
        tool_name: "synthetic_output".to_string(),
    }
}

#[tokio::test]
async fn exact_one_mib_is_recoverable_after_store_reopen() {
    const ONE_MIB: usize = 1024 * 1024;
    let keyword = "MIDDLE-KEYWORD-零三-🙂";
    let remaining = ONE_MIB - keyword.len();
    let left = remaining / 2;
    let right = remaining - left;
    let text = format!("{}{}{}", "A".repeat(left), keyword, "Z".repeat(right));
    assert_eq!(text.len(), ONE_MIB);

    let dir = tempfile::tempdir().expect("temp dir");
    let locator = {
        let store = LocalSpillStore::new(dir.path());
        let outcome = retain_text(&store, &source(), &text, 16 * 1024).await;
        let RetentionOutcome::Spilled {
            projection,
            reference,
            ..
        } = outcome
        else {
            panic!("expected exact 1 MiB result to spill");
        };
        assert!(projection.len() <= 16 * 1024);
        assert!(projection.contains(&reference.locator));
        reference.locator
    };

    let reopened = LocalSpillStore::new(dir.path());
    assert_eq!(reopened.read_text(&locator).await.unwrap(), text);
    assert_eq!(reopened.read_source(&locator).await.unwrap(), source());
}

#[tokio::test]
async fn fork_can_recover_parent_spill_from_shared_persistent_root() {
    let dir = tempfile::tempdir().expect("temp dir");
    let parent_store = LocalSpillStore::new(dir.path());
    let parent_text = format!(
        "parent-start\n{}\nparent-end",
        "fork-visible-middle".repeat(8_192)
    );
    let outcome = retain_text(&parent_store, &source(), &parent_text, 4 * 1024).await;
    let RetentionOutcome::Spilled { reference, .. } = outcome else {
        panic!("expected parent output to spill");
    };
    drop(parent_store);

    // A fork has a different active Codex thread, but it inherits the parent's
    // conversation/history and therefore the opaque locator. Recovery is a
    // durable artifact lookup, not an in-memory parent-thread object lookup.
    let fork_store = LocalSpillStore::new(dir.path());
    assert_eq!(
        fork_store.read_text(&reference.locator).await.unwrap(),
        parent_text
    );
    assert_eq!(
        fork_store
            .read_source(&reference.locator)
            .await
            .unwrap()
            .thread_id,
        "parent-thread"
    );
}
