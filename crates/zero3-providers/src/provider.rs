use async_trait::async_trait;

/// Shared contract every provider (Computer, Browser, and future kinds)
/// implements, independent of what actions it actually executes. This is
/// what `ProviderRegistry` is generic over, so registration, health
/// checks, and capability-based selection work the same way for any
/// provider kind.
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;

    /// Machine-readable capability tags this provider advertises, e.g.
    /// `"click"`, `"screenshot"`. Used by `ProviderRegistry::select` to
    /// find a provider for a given need without the caller hard-coding
    /// which concrete provider to use. Default: none advertised.
    fn capabilities(&self) -> Vec<String> {
        Vec::new()
    }

    /// Cheap liveness/readiness check. Default: always healthy — override
    /// for a provider that has a real backend to reach.
    async fn health_check(&self) -> anyhow::Result<()> {
        Ok(())
    }
}
