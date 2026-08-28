use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use zero3_core::subagent::{SubagentResult, SubagentTask, SubagentWorker};

#[derive(Default)]
pub struct SubagentRegistry {
    workers: Mutex<HashMap<String, Arc<dyn SubagentWorker>>>,
}

impl SubagentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers under `worker.name()`. Registering a second worker under
    /// the same name replaces the first — last registration wins, same as
    /// a plain map insert.
    pub fn register(&self, worker: Arc<dyn SubagentWorker>) {
        self.workers
            .lock()
            .unwrap()
            .insert(worker.name().to_string(), worker);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn SubagentWorker>> {
        self.workers.lock().unwrap().get(name).cloned()
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.workers.lock().unwrap().keys().cloned().collect();
        names.sort();
        names
    }

    pub async fn dispatch(&self, name: &str, task: SubagentTask) -> anyhow::Result<SubagentResult> {
        let worker = self
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("no subagent worker registered under '{name}'"))?;
        worker.dispatch(task).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;

    struct EchoWorker;

    #[async_trait]
    impl SubagentWorker for EchoWorker {
        fn name(&self) -> &str {
            "echo"
        }

        async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult> {
            Ok(SubagentResult {
                summary: format!("echoed: {}", task.goal),
                output: task.context,
            })
        }
    }

    #[tokio::test]
    async fn register_then_dispatch_by_name() {
        let registry = SubagentRegistry::new();
        registry.register(Arc::new(EchoWorker));

        assert_eq!(registry.list(), vec!["echo".to_string()]);

        let result = registry
            .dispatch(
                "echo",
                SubagentTask {
                    goal: "say hi".into(),
                    context: json!({"x": 1}),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.summary, "echoed: say hi");
        assert_eq!(result.output, json!({"x": 1}));
    }

    #[tokio::test]
    async fn dispatch_to_unregistered_name_fails_cleanly() {
        let registry = SubagentRegistry::new();
        let err = registry
            .dispatch(
                "nobody",
                SubagentTask {
                    goal: "anything".into(),
                    context: json!({}),
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("nobody"));
    }
}
