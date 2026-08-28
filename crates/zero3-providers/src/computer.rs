use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::provider::Provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ComputerAction {
    Screenshot,
    Click { x: i32, y: i32 },
    Type { text: String },
    KeyPress { key: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerActionResult {
    pub ok: bool,
    pub detail: serde_json::Value,
}

/// Backend-agnostic Computer Use seam. Concrete providers:
/// - `OpenComputerUseAdapter`: shells out to `iFurySt/open-codex-computer-use`.
/// - `WindowsUiaProvider`: native Windows UI Automation (future).
/// - `VisionFallbackProvider`: screenshot + vision model grounding (future).
#[async_trait]
pub trait ComputerProvider: Provider {
    async fn execute(&self, action: ComputerAction) -> anyhow::Result<ComputerActionResult>;
}

/// Not-yet-wired placeholder so the workspace compiles and the seam is
/// exercised end-to-end before a real Computer Use backend is registered.
pub struct UnimplementedComputerProvider;

#[async_trait]
impl Provider for UnimplementedComputerProvider {
    fn name(&self) -> &str {
        "unimplemented"
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        anyhow::bail!("no ComputerProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[async_trait]
impl ComputerProvider for UnimplementedComputerProvider {
    async fn execute(&self, _action: ComputerAction) -> anyhow::Result<ComputerActionResult> {
        anyhow::bail!("no ComputerProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Security boundary: an unwired provider must never report a
    /// side-effecting action as having succeeded. A silent `Ok` here
    /// would look, to a caller, indistinguishable from a click that
    /// actually happened.
    #[tokio::test]
    async fn unimplemented_provider_never_reports_success() {
        let provider = UnimplementedComputerProvider;
        assert!(provider.execute(ComputerAction::Screenshot).await.is_err());
        assert!(provider
            .execute(ComputerAction::Click { x: 0, y: 0 })
            .await
            .is_err());
        assert!(provider.health_check().await.is_err());
        assert!(provider.capabilities().is_empty());
    }
}
