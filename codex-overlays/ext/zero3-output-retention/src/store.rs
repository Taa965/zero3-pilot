use std::future::Future;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;

const LOCATOR_PREFIX: &str = "zero3-spill://v1/";

pub type SpillFuture<'a, T> = Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'a>>;

/// Stable information about the Codex tool call that produced a spill.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpillSource {
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub tool_name: String,
}

/// Opaque durable reference to a complete tool result.
///
/// `locator` intentionally contains no filesystem path. Callers must resolve it
/// through the owning [`SpillStore`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpillRef {
    pub locator: String,
    pub byte_len: usize,
}

/// Durable storage used by output retention and its recovery tools.
pub trait SpillStore: Send + Sync {
    fn save_text<'a>(&'a self, source: &'a SpillSource, text: &'a str)
    -> SpillFuture<'a, SpillRef>;

    fn read_text<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, String>;

    fn read_source<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, SpillSource>;
}

/// Filesystem-backed spill storage. The physical root is host-owned and never
/// appears in a model-facing locator.
#[derive(Debug)]
pub struct LocalSpillStore {
    root: PathBuf,
    next_id: AtomicU64,
}

impl LocalSpillStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            next_id: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn allocate_id(&self) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{:x}-{:x}-{:x}", std::process::id(), nanos, sequence)
    }

    fn parse_locator(locator: &str) -> io::Result<&str> {
        let id = locator.strip_prefix(LOCATOR_PREFIX).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "unsupported spill locator")
        })?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid spill locator",
            ));
        }
        Ok(id)
    }

    fn data_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.txt"))
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    async fn remove_if_present(path: &Path) {
        if let Err(error) = tokio::fs::remove_file(path).await
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(path = %path.display(), %error, "failed to clean partial spill file");
        }
    }
}

impl SpillStore for LocalSpillStore {
    fn save_text<'a>(
        &'a self,
        source: &'a SpillSource,
        text: &'a str,
    ) -> SpillFuture<'a, SpillRef> {
        Box::pin(async move {
            tokio::fs::create_dir_all(&self.root).await?;

            let id = self.allocate_id();
            let data_path = self.data_path(&id);
            let metadata_path = self.metadata_path(&id);
            let data_tmp = self.root.join(format!(".{id}.txt.tmp"));
            let metadata_tmp = self.root.join(format!(".{id}.json.tmp"));

            let metadata = serde_json::to_vec(source)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;

            if let Err(error) = tokio::fs::write(&data_tmp, text.as_bytes()).await {
                Self::remove_if_present(&data_tmp).await;
                return Err(error);
            }
            if let Err(error) = tokio::fs::write(&metadata_tmp, metadata).await {
                Self::remove_if_present(&data_tmp).await;
                Self::remove_if_present(&metadata_tmp).await;
                return Err(error);
            }
            if let Err(error) = tokio::fs::rename(&data_tmp, &data_path).await {
                Self::remove_if_present(&data_tmp).await;
                Self::remove_if_present(&metadata_tmp).await;
                return Err(error);
            }
            if let Err(error) = tokio::fs::rename(&metadata_tmp, &metadata_path).await {
                Self::remove_if_present(&data_path).await;
                Self::remove_if_present(&metadata_tmp).await;
                return Err(error);
            }

            Ok(SpillRef {
                locator: format!("{LOCATOR_PREFIX}{id}"),
                byte_len: text.len(),
            })
        })
    }

    fn read_text<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, String> {
        Box::pin(async move {
            let id = Self::parse_locator(locator)?;
            let bytes = tokio::fs::read(self.data_path(id)).await?;
            String::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        })
    }

    fn read_source<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, SpillSource> {
        Box::pin(async move {
            let id = Self::parse_locator(locator)?;
            let bytes = tokio::fs::read(self.metadata_path(id)).await?;
            serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SpillSource {
        SpillSource {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            call_id: "call-1".to_string(),
            tool_name: "exec_command".to_string(),
        }
    }

    #[tokio::test]
    async fn local_store_round_trips_text_and_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = LocalSpillStore::new(dir.path());
        let text = "完整输出🙂\nsecond line";
        let reference = store.save_text(&source(), text).await.expect("save");

        assert_eq!(reference.byte_len, text.len());
        assert!(reference.locator.starts_with(LOCATOR_PREFIX));
        assert!(
            !reference
                .locator
                .contains(dir.path().to_string_lossy().as_ref())
        );
        assert_eq!(store.read_text(&reference.locator).await.unwrap(), text);
        assert_eq!(
            store.read_source(&reference.locator).await.unwrap(),
            source()
        );
    }

    #[tokio::test]
    async fn rejects_path_traversal_and_foreign_locators() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = LocalSpillStore::new(dir.path());

        assert!(store.read_text("file:///tmp/result").await.is_err());
        assert!(
            store
                .read_text("zero3-spill://v1/../../secret")
                .await
                .is_err()
        );
    }
}
