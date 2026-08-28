//! Plugin / capability provider lifecycle.
//!
//! Anything that isn't core execution (computer, browser, scheduler, memory,
//! third-party integrations) should be expressible as a plugin against this
//! trait rather than hard-coded into Codex Core.

use async_trait::async_trait;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginState {
    Registered,
    Started,
    Stopped,
    Failed,
}

#[async_trait]
pub trait Plugin: Send + Sync {
    fn id(&self) -> &str;
    fn version(&self) -> &str;

    async fn start(&mut self) -> anyhow::Result<()>;
    async fn stop(&mut self) -> anyhow::Result<()>;
}
