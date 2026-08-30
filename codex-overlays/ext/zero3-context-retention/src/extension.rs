use std::sync::Arc;

use codex_extension_api::CompactionHistoryItemFuture;
use codex_extension_api::CompactionHistoryItemInput;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ToolLifecycleContributor;
use codex_zero3_output_retention::SpillStore;

use crate::PruneConfig;
use crate::projection::project_compaction_history_item;

#[derive(Clone)]
pub struct ContextRetentionExtension {
    store: Arc<dyn SpillStore>,
    config: PruneConfig,
}

impl std::fmt::Debug for ContextRetentionExtension {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContextRetentionExtension")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl ContextRetentionExtension {
    pub fn new(store: Arc<dyn SpillStore>, config: PruneConfig) -> Self {
        Self { store, config }
    }

    pub fn config(&self) -> PruneConfig {
        self.config
    }
}

impl ToolLifecycleContributor for ContextRetentionExtension {
    fn on_compaction_history_item<'a>(
        &'a self,
        input: CompactionHistoryItemInput<'a>,
    ) -> CompactionHistoryItemFuture<'a> {
        Box::pin(async move {
            project_compaction_history_item(self.store.as_ref(), self.config, input).await
        })
    }
}

/// Registers only the D2 compaction-history projection contributor.
///
/// S0/S1 owns the shared registry wiring and must pass the same persistent D1
/// SpillStore used by `zero3-output-retention`; D2 never constructs a competing
/// spill store or physical-path authority.
pub fn install<C: Sync>(
    registry: &mut ExtensionRegistryBuilder<C>,
    store: Arc<dyn SpillStore>,
    config: PruneConfig,
) -> Arc<ContextRetentionExtension> {
    let extension = Arc::new(ContextRetentionExtension::new(store, config));
    registry.tool_lifecycle_contributor(extension.clone());
    extension
}
