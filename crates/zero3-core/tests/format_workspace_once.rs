use std::path::Path;
use std::process::Command;

#[test]
fn format_workspace_once() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Command::new("cargo")
        .args(["fmt", "--all"])
        .current_dir(root)
        .status()
        .expect("spawn cargo fmt");
    assert!(status.success(), "cargo fmt --all failed: {status}");
}
