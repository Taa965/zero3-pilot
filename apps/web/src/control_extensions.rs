use std::collections::BTreeMap;
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const TASK_EXTENSION_SCHEMA: &str = "zero3.pilot.task-extension.v1";
const MAX_EXTENSION_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub struct TaskExtensionRuntime {
    store: Option<Arc<TaskExtensionStore>>,
    auth: Option<Arc<ExtensionAuth>>,
}

#[derive(Clone)]
struct ExtensionAuth {
    host_token: String,
    control_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskExtensionRecord {
    pub schema: String,
    pub task_id: String,
    pub execution_id: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_context: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct PutTaskExtensionBody {
    schema: String,
    execution_id: String,
    #[serde(default)]
    expected_version: Option<u64>,
    #[serde(default)]
    project_context: Option<Value>,
    #[serde(default)]
    handoff: Option<Value>,
    #[serde(default)]
    provider: Option<Value>,
    #[serde(default)]
    review: Option<Value>,
}

#[derive(Default)]
struct TaskExtensionState {
    records: BTreeMap<String, TaskExtensionRecord>,
}

struct TaskExtensionStore {
    root: PathBuf,
    state: Mutex<TaskExtensionState>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task extension persistence failure: {error}"),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl TaskExtensionRuntime {
    pub fn from_env() -> anyhow::Result<Self> {
        let host_token_file = std::env::var("ZERO3_HOST_TOKEN_FILE").ok();
        let control_token_file = std::env::var("ZERO3_CONTROL_TOKEN_FILE").ok();

        match (host_token_file, control_token_file) {
            (None, None) => Ok(Self {
                store: None,
                auth: None,
            }),
            (Some(_), None) | (None, Some(_)) => anyhow::bail!(
                "ZERO3_HOST_TOKEN_FILE and ZERO3_CONTROL_TOKEN_FILE must be configured together"
            ),
            (Some(host_file), Some(control_file)) => {
                let host_token = read_secret_file(&host_file)?;
                let control_token = read_secret_file(&control_file)?;
                let root = std::env::var("ZERO3_CONTROL_PLANE_DATA_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("/var/lib/zero3-pilot/control-plane"))
                    .join("task-extensions");
                let store = TaskExtensionStore::open(root)?;
                Ok(Self {
                    store: Some(Arc::new(store)),
                    auth: Some(Arc::new(ExtensionAuth {
                        host_token,
                        control_token,
                    })),
                })
            }
        }
    }

    #[cfg(test)]
    fn test(root: PathBuf, host_token: &str, control_token: &str) -> anyhow::Result<Self> {
        Ok(Self {
            store: Some(Arc::new(TaskExtensionStore::open(root)?)),
            auth: Some(Arc::new(ExtensionAuth {
                host_token: host_token.to_string(),
                control_token: control_token.to_string(),
            })),
        })
    }
}

pub fn router(runtime: TaskExtensionRuntime) -> Router {
    Router::new()
        .route(
            "/api/control/v1/tasks/:task_id/extensions",
            get(control_get_extension).post(control_put_extension),
        )
        .route(
            "/api/host/v1/tasks/:task_id/extensions",
            get(host_get_extension),
        )
        .with_state(runtime)
}

impl TaskExtensionStore {
    fn open(root: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&root)?;
        let mut state = TaskExtensionState::default();
        for entry in fs::read_dir(&root)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            if bytes.len() > MAX_EXTENSION_BYTES {
                anyhow::bail!("persisted task extension exceeds maximum size: {}", path.display());
            }
            let record: TaskExtensionRecord = serde_json::from_slice(&bytes)?;
            validate_id("persisted task_id", &record.task_id).map_err(|e| anyhow::anyhow!(e.message))?;
            validate_id("persisted execution_id", &record.execution_id)
                .map_err(|e| anyhow::anyhow!(e.message))?;
            if record.schema != TASK_EXTENSION_SCHEMA || record.version == 0 {
                anyhow::bail!("invalid persisted task extension: {}", path.display());
            }
            state.records.insert(record.task_id.clone(), record);
        }
        Ok(Self {
            root,
            state: Mutex::new(state),
        })
    }

    fn get(&self, task_id: &str) -> Result<Option<TaskExtensionRecord>, ApiError> {
        validate_id("task_id", task_id)?;
        Ok(self.state.lock().unwrap().records.get(task_id).cloned())
    }

    fn put(
        &self,
        task_id: &str,
        body: PutTaskExtensionBody,
    ) -> Result<TaskExtensionRecord, ApiError> {
        validate_id("task_id", task_id)?;
        validate_id("execution_id", &body.execution_id)?;
        if body.schema != TASK_EXTENSION_SCHEMA {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "unsupported task extension schema",
            ));
        }
        if body.project_context.is_none()
            && body.handoff.is_none()
            && body.provider.is_none()
            && body.review.is_none()
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "task extension must contain at least one extension field",
            ));
        }

        let candidate_size = serde_json::to_vec(&body)
            .map_err(ApiError::internal)?
            .len();
        if candidate_size > MAX_EXTENSION_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "task extension exceeds the 512 KiB limit",
            ));
        }

        let mut state = self.state.lock().unwrap();
        let existing = state.records.get(task_id).cloned();
        if let Some(existing) = &existing {
            if existing.execution_id != body.execution_id {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "task_id is already bound to a different execution_id",
                ));
            }
        }
        let current_version = existing.as_ref().map(|value| value.version).unwrap_or(0);
        if let Some(expected) = body.expected_version {
            if expected != current_version {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    format!(
                        "task extension version conflict: expected {expected}, current {current_version}"
                    ),
                ));
            }
        }

        let now = Utc::now();
        let record = TaskExtensionRecord {
            schema: TASK_EXTENSION_SCHEMA.to_string(),
            task_id: task_id.to_string(),
            execution_id: body.execution_id,
            version: current_version
                .checked_add(1)
                .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "task extension version exhausted"))?,
            project_context: body.project_context,
            handoff: body.handoff,
            provider: body.provider,
            review: body.review,
            created_at: existing.as_ref().map(|value| value.created_at).unwrap_or(now),
            updated_at: now,
        };
        self.persist(&record).map_err(ApiError::internal)?;
        state.records.insert(task_id.to_string(), record.clone());
        Ok(record)
    }

    fn persist(&self, record: &TaskExtensionRecord) -> anyhow::Result<()> {
        let target = self.root.join(format!("{}.json", record.task_id));
        let temporary = self
            .root
            .join(format!("{}.tmp-{}", record.task_id, uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(record)?;
        if bytes.len() > MAX_EXTENSION_BYTES {
            anyhow::bail!("task extension exceeds maximum size after serialization");
        }
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, &target)?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum AuthRole {
    Host,
    Control,
}

fn require_store(
    runtime: &TaskExtensionRuntime,
    headers: &HeaderMap,
    role: AuthRole,
) -> Result<Arc<TaskExtensionStore>, ApiError> {
    let store = runtime.store.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "remote control plane is not configured",
        )
    })?;
    let auth = runtime.auth.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "remote control plane is not configured",
        )
    })?;
    let expected = match role {
        AuthRole::Host => &auth.host_token,
        AuthRole::Control => &auth.control_token,
    };
    let supplied = bearer_token(headers)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "missing bearer token"))?;
    if supplied != expected {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid bearer token"));
    }
    Ok(store)
}

async fn control_get_extension(
    State(runtime): State<TaskExtensionRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let store = require_store(&runtime, &headers, AuthRole::Control)?;
    match store.get(&task_id)? {
        Some(record) => Ok(Json(serde_json::to_value(record).map_err(ApiError::internal)?)),
        None => Ok(Json(json!({
            "schema": TASK_EXTENSION_SCHEMA,
            "task_id": task_id,
            "version": 0
        }))),
    }
}

async fn host_get_extension(
    State(runtime): State<TaskExtensionRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let store = require_store(&runtime, &headers, AuthRole::Host)?;
    match store.get(&task_id)? {
        Some(record) => Ok(Json(serde_json::to_value(record).map_err(ApiError::internal)?)),
        None => Ok(Json(json!({
            "schema": TASK_EXTENSION_SCHEMA,
            "task_id": task_id,
            "version": 0
        }))),
    }
}

async fn control_put_extension(
    State(runtime): State<TaskExtensionRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PutTaskExtensionBody>,
) -> Result<(StatusCode, Json<TaskExtensionRecord>), ApiError> {
    let store = require_store(&runtime, &headers, AuthRole::Control)?;
    let existed = store.get(&task_id)?.is_some();
    let record = store.put(&task_id, body)?;
    Ok((
        if existed {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(record),
    ))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("authorization")?.to_str().ok()?;
    value.strip_prefix("Bearer ").map(str::trim).filter(|value| !value.is_empty())
}

fn validate_id(label: &str, value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("{label} must be 1-128 ASCII letters, digits, '.', '_' or '-'"),
        ));
    }
    Ok(())
}

fn read_secret_file(path: impl AsRef<FsPath>) -> anyhow::Result<String> {
    let value = fs::read_to_string(path)?.trim().to_string();
    if value.is_empty() {
        anyhow::bail!("secret token file must not be empty");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tempfile::tempdir;
    use tower::ServiceExt;

    #[tokio::test]
    async fn extension_store_is_versioned_and_host_readable() {
        let dir = tempdir().unwrap();
        let runtime = TaskExtensionRuntime::test(dir.path().to_path_buf(), "host", "control").unwrap();
        let app = router(runtime);
        let body = json!({
            "schema": TASK_EXTENSION_SCHEMA,
            "execution_id": "exec-1",
            "expected_version": 0,
            "project_context": { "project_id": "zero3", "context_version": 2 },
            "handoff": { "return_entry_id": "gpt-web-1" }
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/v1/tasks/task-1/extensions")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/host/v1/tasks/task-1/extensions")
                    .header("authorization", "Bearer host")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn extension_store_rejects_stale_writers_and_execution_rebind() {
        let dir = tempdir().unwrap();
        let store = TaskExtensionStore::open(dir.path().to_path_buf()).unwrap();
        let first = store
            .put(
                "task-1",
                PutTaskExtensionBody {
                    schema: TASK_EXTENSION_SCHEMA.into(),
                    execution_id: "exec-1".into(),
                    expected_version: Some(0),
                    project_context: Some(json!({"project_id": "zero3"})),
                    handoff: None,
                    provider: None,
                    review: None,
                },
            )
            .unwrap();
        assert_eq!(first.version, 1);

        let stale = store.put(
            "task-1",
            PutTaskExtensionBody {
                schema: TASK_EXTENSION_SCHEMA.into(),
                execution_id: "exec-1".into(),
                expected_version: Some(0),
                project_context: Some(json!({"project_id": "zero3", "v": 2})),
                handoff: None,
                provider: None,
                review: None,
            },
        );
        assert_eq!(stale.unwrap_err().status, StatusCode::CONFLICT);

        let rebind = store.put(
            "task-1",
            PutTaskExtensionBody {
                schema: TASK_EXTENSION_SCHEMA.into(),
                execution_id: "exec-2".into(),
                expected_version: Some(1),
                project_context: Some(json!({"project_id": "zero3"})),
                handoff: None,
                provider: None,
                review: None,
            },
        );
        assert_eq!(rebind.unwrap_err().status, StatusCode::CONFLICT);
    }
}
