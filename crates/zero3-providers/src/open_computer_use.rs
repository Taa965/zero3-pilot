use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::computer::{ComputerAction, ComputerActionResult, ComputerProvider};
use crate::provider::Provider;

/// Adapter for `iFurySt/open-codex-computer-use`, Phase 1's chosen
/// integration instead of reimplementing Windows Computer Use from
/// scratch (see docs/ARCHITECTURE.md). Speaks a minimal line-delimited
/// JSON protocol over the child process's stdio: one `ComputerAction` in
/// on stdin, one `ComputerActionResult` out on stdout. Points at a
/// configurable executable rather than a hard-coded path, so the same
/// adapter runs against the real OCU binary once installed, or against a
/// test double (`src/bin/fake_ocu.rs`) in tests.
pub struct OpenComputerUseAdapter {
    executable: PathBuf,
    call_timeout: Duration,
}

impl OpenComputerUseAdapter {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            call_timeout: Duration::from_secs(10),
        }
    }

    pub fn with_timeout(mut self, call_timeout: Duration) -> Self {
        self.call_timeout = call_timeout;
        self
    }

    async fn call(&self, action: &ComputerAction) -> anyhow::Result<ComputerActionResult> {
        let mut request = serde_json::to_string(action)?;
        request.push('\n');

        let mut child = Command::new(&self.executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // If we bail out early (timeout, I/O error), don't leak an
            // orphaned backend process still running in the background.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                anyhow::anyhow!(
                    "failed to spawn open-computer-use adapter at {:?}: {e}",
                    self.executable
                )
            })?;

        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let mut reader = BufReader::new(stdout);

        let call = async {
            stdin.write_all(request.as_bytes()).await?;
            stdin.shutdown().await?;
            let mut line = String::new();
            reader.read_line(&mut line).await?;
            Ok::<String, std::io::Error>(line)
        };

        let line = timeout(self.call_timeout, call).await.map_err(|_| {
            anyhow::anyhow!(
                "open-computer-use adapter timed out after {:?}",
                self.call_timeout
            )
        })??;

        let _ = child.wait().await;

        if line.trim().is_empty() {
            anyhow::bail!("open-computer-use adapter returned no output");
        }
        let result: ComputerActionResult = serde_json::from_str(line.trim())
            .map_err(|e| anyhow::anyhow!("open-computer-use adapter returned invalid JSON: {e}"))?;
        Ok(result)
    }
}

#[async_trait]
impl Provider for OpenComputerUseAdapter {
    fn name(&self) -> &str {
        "open-computer-use"
    }

    fn capabilities(&self) -> Vec<String> {
        vec![
            "screenshot".into(),
            "click".into(),
            "type".into(),
            "key_press".into(),
        ]
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        let result = self.call(&ComputerAction::Screenshot).await?;
        if result.ok {
            Ok(())
        } else {
            anyhow::bail!(
                "open-computer-use health check reported not-ok: {:?}",
                result.detail
            )
        }
    }
}

#[async_trait]
impl ComputerProvider for OpenComputerUseAdapter {
    async fn execute(&self, action: ComputerAction) -> anyhow::Result<ComputerActionResult> {
        self.call(&action).await
    }
}
