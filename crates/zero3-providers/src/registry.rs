use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::provider::Provider;

/// Registers providers of one kind (e.g. `dyn ComputerProvider`, which is
/// itself a `Provider`) by name, and supports capability-based selection
/// and health checks without the caller depending on a concrete provider
/// type.
pub struct ProviderRegistry<T: ?Sized> {
    providers: Mutex<HashMap<String, Arc<T>>>,
}

impl<T: ?Sized> Default for ProviderRegistry<T> {
    fn default() -> Self {
        Self {
            providers: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: ?Sized + Provider> ProviderRegistry<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers under `provider.name()`. Registering a second provider
    /// under the same name replaces the first.
    pub fn register(&self, provider: Arc<T>) {
        let name = provider.name().to_string();
        self.providers.lock().unwrap().insert(name, provider);
    }

    pub fn get(&self, name: &str) -> Option<Arc<T>> {
        self.providers.lock().unwrap().get(name).cloned()
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.providers.lock().unwrap().keys().cloned().collect();
        names.sort();
        names
    }

    /// The first registered provider (by name, ascending) advertising the
    /// given capability — deterministic when more than one qualifies.
    /// `None` if nobody advertises it, rather than guessing.
    pub fn select(&self, capability: &str) -> Option<Arc<T>> {
        let mut candidates: Vec<(String, Arc<T>)> = {
            let providers = self.providers.lock().unwrap();
            providers
                .iter()
                .filter(|(_, p)| p.capabilities().iter().any(|c| c == capability))
                .map(|(name, p)| (name.clone(), p.clone()))
                .collect()
        };
        candidates.sort_by(|a, b| a.0.cmp(&b.0));
        candidates.into_iter().next().map(|(_, p)| p)
    }

    pub async fn health_check(&self, name: &str) -> anyhow::Result<()> {
        let provider = self
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("no provider registered under '{name}'"))?;
        provider.health_check().await
    }

    /// Health-checks every registered provider and returns each result by
    /// name — a caller can distinguish "provider X is unhealthy" from
    /// "provider X isn't registered" without probing one at a time.
    pub async fn health_check_all(&self) -> HashMap<String, anyhow::Result<()>> {
        let snapshot: Vec<(String, Arc<T>)> = {
            let providers = self.providers.lock().unwrap();
            providers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        let mut results = HashMap::new();
        for (name, provider) in snapshot {
            results.insert(name, provider.health_check().await);
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct Healthy(&'static str, Vec<&'static str>);
    struct Unhealthy(&'static str);

    #[async_trait]
    impl Provider for Healthy {
        fn name(&self) -> &str {
            self.0
        }
        fn capabilities(&self) -> Vec<String> {
            self.1.iter().map(|s| s.to_string()).collect()
        }
    }

    #[async_trait]
    impl Provider for Unhealthy {
        fn name(&self) -> &str {
            self.0
        }
        async fn health_check(&self) -> anyhow::Result<()> {
            anyhow::bail!("{} is down", self.0)
        }
    }

    #[test]
    fn register_get_list() {
        let registry: ProviderRegistry<dyn Provider> = ProviderRegistry::new();
        registry.register(Arc::new(Healthy("b", vec![])));
        registry.register(Arc::new(Healthy("a", vec![])));
        assert_eq!(registry.list(), vec!["a".to_string(), "b".to_string()]);
        assert!(registry.get("a").is_some());
        assert!(registry.get("nope").is_none());
    }

    #[test]
    fn select_finds_first_matching_capability_deterministically() {
        let registry: ProviderRegistry<dyn Provider> = ProviderRegistry::new();
        registry.register(Arc::new(Healthy("zeta", vec!["click"])));
        registry.register(Arc::new(Healthy("alpha", vec!["click"])));
        registry.register(Arc::new(Healthy("other", vec!["type"])));

        let selected = registry.select("click").unwrap();
        assert_eq!(selected.name(), "alpha"); // alphabetically first match

        assert!(registry.select("nonexistent-capability").is_none());
    }

    #[tokio::test]
    async fn health_check_distinguishes_missing_from_unhealthy() {
        let registry: ProviderRegistry<dyn Provider> = ProviderRegistry::new();
        registry.register(Arc::new(Unhealthy("bad")));

        assert!(registry.health_check("bad").await.is_err());
        assert!(registry.health_check("missing").await.is_err());

        let all = registry.health_check_all().await;
        assert!(all.get("bad").unwrap().is_err());
        assert!(!all.contains_key("missing"));
    }
}
