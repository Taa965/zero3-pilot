use std::time::Duration;

use zero3_providers::computer::{ComputerAction, ComputerProvider};
use zero3_providers::open_computer_use::OpenComputerUseAdapter;
use zero3_providers::provider::Provider;

#[tokio::test]
async fn executes_and_health_checks_against_the_fake_binary() {
    let bin = env!("CARGO_BIN_EXE_fake_ocu");
    let adapter = OpenComputerUseAdapter::new(bin);

    let result = adapter.execute(ComputerAction::Screenshot).await.unwrap();
    assert!(result.ok);

    adapter.health_check().await.unwrap();
    assert_eq!(adapter.name(), "open-computer-use");
    assert!(adapter.capabilities().contains(&"click".to_string()));
}

#[tokio::test]
async fn missing_binary_fails_gracefully_not_panicking() {
    let adapter = OpenComputerUseAdapter::new("/nonexistent/path/to/ocu-binary-zzz");
    let err = adapter
        .execute(ComputerAction::Screenshot)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("failed to spawn"));
}

#[tokio::test]
async fn a_hung_backend_times_out_instead_of_blocking_forever() {
    // fake_ocu_hang never reads stdin or writes stdout — the adapter's
    // read_line would block forever without the timeout guard.
    let bin = env!("CARGO_BIN_EXE_fake_ocu_hang");
    let adapter = OpenComputerUseAdapter::new(bin).with_timeout(Duration::from_millis(300));

    let err = adapter
        .execute(ComputerAction::Screenshot)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"));
}
