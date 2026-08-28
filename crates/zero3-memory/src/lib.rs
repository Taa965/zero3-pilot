//! Memory placeholder. Phase 1 defines the trait only; a first backend
//! (local file / SQLite, semantic to `~/.claude`'s memory convention) lands
//! in a later pass.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub key: String,
    pub value: serde_json::Value,
}

pub trait MemoryStore: Send + Sync {
    fn get(&self, key: &str) -> anyhow::Result<Option<MemoryRecord>>;
    fn put(&self, record: MemoryRecord) -> anyhow::Result<()>;
}
