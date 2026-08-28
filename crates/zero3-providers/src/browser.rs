use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::provider::Provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BrowserAction {
    Navigate { url: String },
    Click { selector: String },
    Type { selector: String, text: String },
    ReadText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserActionResult {
    pub ok: bool,
    pub detail: serde_json::Value,
}

/// Backend-agnostic browser automation seam (CDP, Playwright, extension-based).
#[async_trait]
pub trait BrowserProvider: Provider {
    async fn execute(&self, action: BrowserAction) -> anyhow::Result<BrowserActionResult>;
}

pub struct UnimplementedBrowserProvider;

#[async_trait]
impl Provider for UnimplementedBrowserProvider {
    fn name(&self) -> &str {
        "unimplemented"
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        anyhow::bail!("no BrowserProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[async_trait]
impl BrowserProvider for UnimplementedBrowserProvider {
    async fn execute(&self, _action: BrowserAction) -> anyhow::Result<BrowserActionResult> {
        anyhow::bail!("no BrowserProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Security boundary: an unwired provider must never report a
    /// side-effecting action (e.g. submitting a form) as having
    /// succeeded.
    #[tokio::test]
    async fn unimplemented_provider_never_reports_success() {
        let provider = UnimplementedBrowserProvider;
        assert!(provider
            .execute(BrowserAction::Navigate {
                url: "https://example.com".into()
            })
            .await
            .is_err());
        assert!(provider.health_check().await.is_err());
        assert!(provider.capabilities().is_empty());
    }
}
