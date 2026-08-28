use std::env;
use std::time::Duration;

use zero3_providers::computer::{ComputerAction, ComputerProvider};
use zero3_providers::open_computer_use::OpenComputerUseAdapter;
use zero3_providers::Provider;

/// Real upstream Open Computer Use smoke. CI invokes this explicitly on
/// Windows after installing the current npm package and opening Notepad.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires real open-computer-use and a Windows desktop session"]
async fn real_windows_ocu_mcp_handshake_tools_and_notepad_state() {
    let binary =
        env::var("ZERO3_OCU_BIN").expect("ZERO3_OCU_BIN must point to open-computer-use.cmd");
    let app = env::var("ZERO3_OCU_APP").unwrap_or_else(|_| "Notepad".into());
    let adapter = OpenComputerUseAdapter::new(binary).with_timeout(Duration::from_secs(30));

    adapter.health_check().await.unwrap();
    let tools = adapter.list_remote_tools().await.unwrap();
    for required in [
        "list_apps",
        "get_app_state",
        "click",
        "type_text",
        "press_key",
    ] {
        assert!(
            tools.iter().any(|tool| tool == required),
            "missing upstream tool {required}: {tools:?}"
        );
    }

    // Real tools/call through the installed Windows native runtime. This is
    // deliberately checked before deep UIA traversal so a hosted-desktop
    // limitation can be distinguished from an MCP/runtime failure.
    let apps = adapter.execute(ComputerAction::ListApps).await.unwrap();
    assert!(
        apps.ok,
        "real list_apps returned MCP error: {:?}",
        apps.detail
    );

    let state = adapter
        .execute(ComputerAction::Screenshot { app })
        .await
        .unwrap();
    assert!(
        state.ok,
        "real get_app_state returned MCP error: {:?}",
        state.detail
    );
    assert!(!state.detail.is_null());

    adapter.shutdown().await.unwrap();
}
