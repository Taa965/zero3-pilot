use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{Provider, ProviderRegistry};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LogicalAgent {
    Gpt,
    Gemini,
    Codex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionProvider {
    ChatgptWeb,
    GeminiWeb,
    CodexLocal,
    GeminiAgent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealth {
    Unknown,
    Ready,
    AuthRequired,
    AuthExpired,
    Unavailable,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderCapabilities {
    pub web_session: bool,
    pub runtime: bool,
    pub files: bool,
    pub shell: bool,
    pub mcp: bool,
    pub git: bool,
    pub structured_output: bool,
    pub interrupt: bool,
    pub resume_conversation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCapabilitySnapshot {
    pub provider_id: String,
    pub logical_agent: LogicalAgent,
    pub available: bool,
    pub authenticated: bool,
    pub health: ProviderHealth,
    pub capabilities: ProviderCapabilities,
    pub checked_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentProviderDescriptor {
    pub id: String,
    pub logical_agent: LogicalAgent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_provider: Option<SessionProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_provider: Option<SessionProvider>,
    pub capabilities: ProviderCapabilities,
}

impl AgentProviderDescriptor {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.id.trim().is_empty() || self.id.len() > 128 {
            anyhow::bail!("agent provider id must be 1-128 characters");
        }
        if !self
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            anyhow::bail!("agent provider id contains unsupported characters");
        }
        match self.logical_agent {
            LogicalAgent::Gpt => {
                if matches!(
                    self.runtime_provider,
                    Some(SessionProvider::GeminiAgent) | Some(SessionProvider::CodexLocal)
                ) {
                    anyhow::bail!("GPT logical agent cannot bind a Gemini/Codex runtime provider");
                }
            }
            LogicalAgent::Gemini => {
                if matches!(self.web_provider, Some(SessionProvider::ChatgptWeb)) {
                    anyhow::bail!("Gemini logical agent cannot bind ChatGPT Web");
                }
                if matches!(self.runtime_provider, Some(SessionProvider::CodexLocal)) {
                    anyhow::bail!("Gemini logical agent cannot bind Codex Local as its runtime identity");
                }
            }
            LogicalAgent::Codex => {
                if self.web_provider.is_some() {
                    anyhow::bail!("Codex logical agent has no web provider in V1");
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrossAgentBinding {
    pub project_id: String,
    pub task_id: String,
    pub origin_session_id: String,
    pub target_logical_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_conversation_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Provider-neutral metadata registry layered on top of the existing generic
/// `ProviderRegistry`. This deliberately does not replace the concrete provider
/// registry: runtime adapters are still registered as `Provider`s and health
/// checked through the existing contract; this layer only adds logical-agent
/// identity and stable capability snapshots for routing/UI.
pub struct AgentProviderRegistry {
    runtime: ProviderRegistry<dyn Provider>,
    descriptors: Mutex<BTreeMap<String, AgentProviderDescriptor>>,
    snapshots: Mutex<BTreeMap<String, ProviderCapabilitySnapshot>>,
}

impl Default for AgentProviderRegistry {
    fn default() -> Self {
        Self {
            runtime: ProviderRegistry::new(),
            descriptors: Mutex::new(BTreeMap::new()),
            snapshots: Mutex::new(BTreeMap::new()),
        }
    }
}

impl AgentProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        descriptor: AgentProviderDescriptor,
        provider: Arc<dyn Provider>,
    ) -> anyhow::Result<()> {
        descriptor.validate()?;
        if descriptor.id != provider.name() {
            anyhow::bail!("descriptor id must match provider.name()");
        }
        self.runtime.register(provider);
        self.descriptors
            .lock()
            .unwrap()
            .insert(descriptor.id.clone(), descriptor);
        Ok(())
    }

    pub fn descriptor(&self, id: &str) -> Option<AgentProviderDescriptor> {
        self.descriptors.lock().unwrap().get(id).cloned()
    }

    pub fn descriptors(&self) -> Vec<AgentProviderDescriptor> {
        self.descriptors.lock().unwrap().values().cloned().collect()
    }

    pub fn snapshot(&self, id: &str) -> Option<ProviderCapabilitySnapshot> {
        self.snapshots.lock().unwrap().get(id).cloned()
    }

    pub async fn refresh(&self, id: &str) -> anyhow::Result<ProviderCapabilitySnapshot> {
        let descriptor = self
            .descriptor(id)
            .ok_or_else(|| anyhow::anyhow!("unknown agent provider '{id}'"))?;
        let runtime = self
            .runtime
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("provider '{id}' is missing its runtime adapter"))?;
        let checked_at = Utc::now();
        let snapshot = match runtime.health_check().await {
            Ok(()) => ProviderCapabilitySnapshot {
                provider_id: id.to_string(),
                logical_agent: descriptor.logical_agent,
                available: true,
                authenticated: true,
                health: ProviderHealth::Ready,
                capabilities: descriptor.capabilities,
                checked_at,
                detail: None,
            },
            Err(error) => ProviderCapabilitySnapshot {
                provider_id: id.to_string(),
                logical_agent: descriptor.logical_agent,
                available: false,
                authenticated: false,
                health: ProviderHealth::Unavailable,
                capabilities: descriptor.capabilities,
                checked_at,
                detail: Some(error.to_string()),
            },
        };
        self.snapshots
            .lock()
            .unwrap()
            .insert(id.to_string(), snapshot.clone());
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct Dummy;

    #[async_trait]
    impl Provider for Dummy {
        fn name(&self) -> &str {
            "gemini-antigravity"
        }
    }

    fn descriptor() -> AgentProviderDescriptor {
        AgentProviderDescriptor {
            id: "gemini-antigravity".into(),
            logical_agent: LogicalAgent::Gemini,
            web_provider: Some(SessionProvider::GeminiWeb),
            runtime_provider: Some(SessionProvider::GeminiAgent),
            capabilities: ProviderCapabilities {
                runtime: true,
                files: true,
                shell: true,
                mcp: true,
                structured_output: true,
                interrupt: true,
                resume_conversation: true,
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn registry_reuses_runtime_provider_contract_and_adds_snapshot() {
        let registry = AgentProviderRegistry::new();
        registry.register(descriptor(), Arc::new(Dummy)).unwrap();
        let snapshot = registry.refresh("gemini-antigravity").await.unwrap();
        assert_eq!(snapshot.health, ProviderHealth::Ready);
        assert_eq!(snapshot.logical_agent, LogicalAgent::Gemini);
        assert!(snapshot.capabilities.runtime);
    }
}
