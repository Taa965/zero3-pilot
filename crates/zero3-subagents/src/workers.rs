//! Placeholder workers for each backend named in the project brief. None
//! are wired up yet — each returns a clear "not implemented" error rather
//! than silently no-op'ing, so a caller can tell "not built yet" apart
//! from "ran and did nothing".

use async_trait::async_trait;
use zero3_core::subagent::{SubagentResult, SubagentTask, SubagentWorker};

macro_rules! unimplemented_worker {
    ($struct_name:ident, $name:literal) => {
        pub struct $struct_name;

        #[async_trait]
        impl SubagentWorker for $struct_name {
            fn name(&self) -> &str {
                $name
            }

            async fn dispatch(&self, _task: SubagentTask) -> anyhow::Result<SubagentResult> {
                anyhow::bail!(concat!(
                    "subagent worker '",
                    $name,
                    "' is not wired up yet (see docs/ARCHITECTURE.md)"
                ))
            }
        }
    };
}

unimplemented_worker!(CodexWorker, "codex");
unimplemented_worker!(ClaudeWorker, "claude");
unimplemented_worker!(HermesWorker, "hermes");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn placeholders_report_not_implemented_not_silent_success() {
        for worker in [
            Box::new(CodexWorker) as Box<dyn SubagentWorker>,
            Box::new(ClaudeWorker),
            Box::new(HermesWorker),
        ] {
            let name = worker.name().to_string();
            let err = worker
                .dispatch(SubagentTask {
                    goal: "anything".into(),
                    context: json!({}),
                })
                .await
                .unwrap_err();
            assert!(err.to_string().contains(&name));
        }
    }
}
