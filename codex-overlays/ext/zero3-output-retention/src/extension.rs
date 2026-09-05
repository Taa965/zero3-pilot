use std::sync::Arc;

use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolLifecycleContributor;
use codex_extension_api::ToolResultFuture;
use codex_extension_api::ToolResultInput;

use crate::SpillStore;
use crate::projection::project_tool_result;
use crate::tools::GrepSpillTool;
use crate::tools::ReadSpillTool;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutputRetentionConfig {
    pub max_inline_bytes: usize,
}

impl Default for OutputRetentionConfig {
    fn default() -> Self {
        Self {
            max_inline_bytes: 16 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct OutputRetentionExtension {
    store: Arc<dyn SpillStore>,
    config: OutputRetentionConfig,
}

impl std::fmt::Debug for OutputRetentionExtension {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputRetentionExtension")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl OutputRetentionExtension {
    pub fn new(store: Arc<dyn SpillStore>, config: OutputRetentionConfig) -> Self {
        Self { store, config }
    }

    pub fn store(&self) -> Arc<dyn SpillStore> {
        Arc::clone(&self.store)
    }

    pub fn config(&self) -> OutputRetentionConfig {
        self.config
    }
}

impl ToolContributor for OutputRetentionExtension {
    fn tools(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        vec![
            Arc::new(ReadSpillTool::new(Arc::clone(&self.store))),
            Arc::new(GrepSpillTool::new(Arc::clone(&self.store))),
        ]
    }
}

impl ToolLifecycleContributor for OutputRetentionExtension {
    fn on_tool_result<'a>(&'a self, input: ToolResultInput<'a>) -> ToolResultFuture<'a> {
        Box::pin(async move { project_tool_result(self.store.as_ref(), self.config, input).await })
    }
}

/// Register the extension-owned recovery tools and result projection callback.
///
/// The global Codex host decides where this helper is called. S2 intentionally
/// does not edit shared extension registry wiring or the workspace manifest.
pub fn install<C: Sync>(
    registry: &mut ExtensionRegistryBuilder<C>,
    store: Arc<dyn SpillStore>,
    config: OutputRetentionConfig,
) -> Arc<OutputRetentionExtension> {
    let extension = Arc::new(OutputRetentionExtension::new(store, config));
    registry.tool_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    extension
}
