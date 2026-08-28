//! Integration tests for `OpenComputerUseAdapter` against the real
//! protocol confirmed against `iFurySt/open-codex-computer-use` upstream
//! source (see `src/open_computer_use.rs`'s module docs for exactly which
//! files/behavior were checked): MCP over stdio, JSON-RPC 2.0.
//!
//! `fake_ocu` (a compiled test double, not a shell script — see
//! `src/bin/fake_ocu.rs`) speaks that same real protocol shape, so these
//! tests exercise the actual handshake/tools_list/tools_call/shutdown
//! sequence a real backend would see, not just our own made-up framing.

use std::time::Duration;

use zero3_providers::computer::{ComputerAction, ComputerProvider};
use zero3_providers::open_computer_use::OpenComputerUseAdapter;
use zero3_providers::provider::Provider;

#[tokio::test]
async fn process_starts_and_the_mcp_handshake_succeeds() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu");
    let adapter = OpenComputerUseAdapter::new(bin);
    adapter.health_check().await.unwrap();
}

#[tokio::test]
async fn capabilities_enumerate_against_the_live_backend() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu");
    let adapter = OpenComputerUseAdapter::new(bin);

    let remote_tools = adapter.list_remote_tools().await.unwrap();
    for expected in [
        "list_apps",
        "click",
        "type_text",
        "press_key",
        "get_app_state",
    ] {
        assert!(remote_tools.contains(&expected.to_string()));
    }

    for capability in adapter.capabilities() {
        assert!(
            remote_tools.contains(&capability),
            "declared capability '{capability}' is not in the backend's real tools/list"
        );
    }
}

#[tokio::test]
async fn execute_maps_each_action_to_the_correct_real_tool_call() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu");
    let adapter = OpenComputerUseAdapter::new(bin);

    let result = adapter.execute(ComputerAction::ListApps).await.unwrap();
    assert!(result.ok);
    assert_eq!(result.detail["echoedTool"], "list_apps");
    assert_eq!(result.detail["echoedArguments"], serde_json::json!({}));

    let result = adapter
        .execute(ComputerAction::Click {
            app: "Finder".into(),
            x: 10,
            y: 20,
        })
        .await
        .unwrap();
    assert!(result.ok);
    assert_eq!(result.detail["echoedTool"], "click");
    assert_eq!(
        result.detail["echoedArguments"],
        serde_json::json!({"app": "Finder", "x": 10, "y": 20})
    );

    let result = adapter
        .execute(ComputerAction::Type {
            app: "Notes".into(),
            text: "hello".into(),
        })
        .await
        .unwrap();
    assert_eq!(result.detail["echoedTool"], "type_text");
    assert_eq!(
        result.detail["echoedArguments"],
        serde_json::json!({"app": "Notes", "text": "hello"})
    );

    let result = adapter
        .execute(ComputerAction::Screenshot {
            app: "Finder".into(),
        })
        .await
        .unwrap();
    assert_eq!(result.detail["echoedTool"], "get_app_state");
    assert_eq!(
        result.detail["echoedArguments"],
        serde_json::json!({
            "app": "Finder",
            "max_tree_nodes": 200,
            "max_tree_depth": 16,
            "text_limit": 4000
        })
    );
}

#[tokio::test]
async fn clean_shutdown_closes_the_session() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu");
    let adapter = OpenComputerUseAdapter::new(bin);

    adapter.health_check().await.unwrap();
    adapter.shutdown().await.unwrap();
    adapter.health_check().await.unwrap();
}

#[tokio::test]
async fn missing_binary_fails_gracefully_not_panicking() {
    let adapter = OpenComputerUseAdapter::new("/nonexistent/path/to/ocu-binary-zzz");
    let err = adapter
        .execute(ComputerAction::Screenshot { app: "x".into() })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("failed to spawn"));
}

#[tokio::test]
async fn a_hung_backend_times_out_instead_of_blocking_forever() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu_hang");
    let adapter = OpenComputerUseAdapter::new(bin).with_timeout(Duration::from_millis(300));

    let err = adapter
        .execute(ComputerAction::Screenshot { app: "x".into() })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"));
}
