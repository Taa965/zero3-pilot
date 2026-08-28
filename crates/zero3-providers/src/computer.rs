use async_trait::async_trait;
use serde::{Deserialize, Serialize};

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
/// - `OpenComputerUse`: shells out to / MCP-calls `iFurySt/open-codex-computer-use`.
/// - `WindowsUiaProvider`: native Windows UI Automation (future).
/// - `VisionFallbackProvider`: screenshot + vision model grounding (future).
#[async_trait]
pub trait ComputerProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn execute(&self, action: ComputerAction) -> anyhow::Result<ComputerActionResult>;
}

/// Not-yet-wired placeholder so the workspace compiles and the seam is
/// exercised end-to-end before the real Open Computer Use integration lands.
pub struct UnimplementedComputerProvider;

#[async_trait]
impl ComputerProvider for UnimplementedComputerProvider {
    fn name(&self) -> &str {
        "unimplemented"
    }

    async fn execute(&self, _action: ComputerAction) -> anyhow::Result<ComputerActionResult> {
        anyhow::bail!("no ComputerProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}
