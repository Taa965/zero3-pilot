use async_trait::async_trait;
use serde::{Deserialize, Serialize};

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
pub trait BrowserProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn execute(&self, action: BrowserAction) -> anyhow::Result<BrowserActionResult>;
}

pub struct UnimplementedBrowserProvider;

#[async_trait]
impl BrowserProvider for UnimplementedBrowserProvider {
    fn name(&self) -> &str {
        "unimplemented"
    }

    async fn execute(&self, _action: BrowserAction) -> anyhow::Result<BrowserActionResult> {
        anyhow::bail!("no BrowserProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}
