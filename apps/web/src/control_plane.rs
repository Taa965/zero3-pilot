use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::{sleep, Instant};
use uuid::Uuid;

pub const REMOTE_TASK_PROTOCOL: &str = "zero3.pilot.remote-task.v1";
const DEFAULT_LEASE_TTL_SECONDS: i64 = 45;
const MAX_LONG_POLL_SECONDS: u64 = 30;
const LONG_POLL_INTERVAL_MS: u64 = 250;
const REQUIRED_HOST_CAPABILITIES: [&str; 3] = ["codex", "thread", "turn"];

#[derive(Clone)]
pub struct RemoteControlRuntime {
    plane: Option<Arc<ControlPlane>>,
    auth: Option<Arc<AuthConfig>>,
}

#[derive(Clone)]
struct AuthConfig {
    host_token: String,
    control_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteTaskTarget {
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct RemoteTaskExecution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_clean_worktree: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteTask {
    pub protocol: String,
    pub task_id: String,
    pub execution_id: String,
    pub objective: String,
    pub target: RemoteTaskTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<RemoteTaskExecution>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTaskState {
    Queued,
    Leased,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Blocked,
    OutcomeUnknown,
    Quarantined,
}

impl RemoteTaskState {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::Failed
                | Self::Cancelled
                | Self::Blocked
                | Self::OutcomeUnknown
                | Self::Quarantined
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LeaseRecord {
    pub node_id: String,
    pub lease_id: String,
    pub fencing_token: u64,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcceptedEvent {
    pub delivery_id: String,
    pub execution_id: String,
    pub lease_id: String,
    pub fencing_token: u64,
    pub event_sequence: u64,
    pub event_type: String,
    pub created_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalRecord {
    pub delivery_id: String,
    pub execution_id: String,
    pub lease_id: String,
    pub fencing_token: u64,
    pub created_at: String,
    pub state: RemoteTaskState,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskRecord {
    pub task: RemoteTask,
    pub task_fingerprint: String,
    pub state: RemoteTaskState,
    pub sticky_node_id: Option<String>,
    pub fencing_token: u64,
    pub active_lease: Option<LeaseRecord>,
    pub last_event_sequence: u64,
    pub events: Vec<AcceptedEvent>,
    pub terminal: Option<TerminalRecord>,
    pub delivery_fingerprints: BTreeMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeRecord {
    pub node_id: String,
    pub capabilities: Vec<String>,
    pub registered_at: DateTime<Utc>,
    pub last_heartbeat_at: DateTime<Utc>,
    pub active_task_id: Option<String>,
    pub pending_deliveries: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteLease {
    pub lease_id: String,
    pub fencing_token: u64,
    pub lease_expires_at: String,
    pub task: RemoteTask,
}

#[derive(Debug, Deserialize)]
struct NodeRegisterBody {
    node_id: String,
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HeartbeatBody {
    node_id: String,
    active_task_id: Option<String>,
    #[serde(default)]
    pending_deliveries: Option<u64>,
    #[allow(dead_code)]
    at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LeaseRequest {
    node_id: String,
    #[serde(default)]
    wait_seconds: Option<u64>,
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RenewBody {
    node_id: String,
    lease_id: String,
    fencing_token: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventEnvelope {
    delivery_id: String,
    execution_id: String,
    lease_id: String,
    fencing_token: u64,
    event_sequence: u64,
    event_type: String,
    created_at: String,
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalEnvelope {
    delivery_id: String,
    execution_id: String,
    lease_id: String,
    fencing_token: u64,
    created_at: String,
    state: RemoteTaskState,
    result: Value,
}

#[derive(Default)]
struct ControlPlaneState {
    tasks: BTreeMap<String, TaskRecord>,
    nodes: BTreeMap<String, NodeRecord>,
}

pub struct ControlPlane {
    root: PathBuf,
    lease_ttl: Duration,
    state: Mutex<ControlPlaneState>,
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
            format!("remote control-plane persistence failure: {error}"),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl RemoteControlRuntime {
    pub fn from_env() -> anyhow::Result<Self> {
        let host_token_file = std::env::var("ZERO3_HOST_TOKEN_FILE").ok();
        let control_token_file = std::env::var("ZERO3_CONTROL_TOKEN_FILE").ok();

        match (host_token_file, control_token_file) {
            (None, None) => Ok(Self {
                plane: None,
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
                    .unwrap_or_else(|_| PathBuf::from("/var/lib/zero3-pilot/control-plane"));
                let plane = ControlPlane::open(root)?;
                Ok(Self {
                    plane: Some(Arc::new(plane)),
                    auth: Some(Arc::new(AuthConfig {
                        host_token,
                        control_token,
                    })),
                })
            }
        }
    }

    #[cfg(test)]
    fn test(root: PathBuf, host_token: &str, control_token: &str, lease_ttl: Duration) -> anyhow::Result<Self> {
        Ok(Self {
            plane: Some(Arc::new(ControlPlane::open_with_ttl(root, lease_ttl)?)),
            auth: Some(Arc::new(AuthConfig {
                host_token: host_token.to_string(),
                control_token: control_token.to_string(),
            })),
        })
    }
}

pub fn router(runtime: RemoteControlRuntime) -> Router {
    Router::new()
        .route("/api/host/v1/nodes/register", post(register_node))
        .route("/api/host/v1/nodes/:node_id/heartbeat", post(heartbeat_node))
        .route("/api/host/v1/tasks/lease", post(lease_task))
        .route("/api/host/v1/tasks/:task_id/renew", post(renew_task))
        .route("/api/host/v1/tasks/:task_id/events", post(accept_event))
        .route("/api/host/v1/tasks/:task_id/complete", post(complete_task))
        .route("/api/host/v1/tasks/:task_id/fail", post(fail_task))
        .route("/api/host/v1/tasks/:task_id/blocked", post(block_task))
        .route("/api/control/v1/tasks", post(create_task).get(list_tasks))
        .route("/api/control/v1/tasks/:task_id", get(get_task))
        .route("/api/control/v1/nodes", get(list_nodes))
        .with_state(runtime)
}

impl ControlPlane {
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        Self::open_with_ttl(root, Duration::seconds(DEFAULT_LEASE_TTL_SECONDS))
    }

    fn open_with_ttl(root: PathBuf, lease_ttl: Duration) -> anyhow::Result<Self> {
        let tasks_dir = root.join("tasks");
        let nodes_dir = root.join("nodes");
        fs::create_dir_all(&tasks_dir)?;
        fs::create_dir_all(&nodes_dir)?;

        let mut state = ControlPlaneState::default();
        for path in json_files(&tasks_dir)? {
            let record: TaskRecord = serde_json::from_slice(&fs::read(&path)?)?;
            validate_id("persisted task_id", &record.task.task_id)
                .map_err(|e| anyhow::anyhow!(e.message))?;
            state.tasks.insert(record.task.task_id.clone(), record);
        }
        for path in json_files(&nodes_dir)? {
            let record: NodeRecord = serde_json::from_slice(&fs::read(&path)?)?;
            validate_id("persisted node_id", &record.node_id)
                .map_err(|e| anyhow::anyhow!(e.message))?;
            state.nodes.insert(record.node_id.clone(), record);
        }

        Ok(Self {
            root,
            lease_ttl,
            state: Mutex::new(state),
        })
    }

    fn create_task(&self, task: RemoteTask) -> Result<TaskRecord, ApiError> {
        validate_task(&task)?;
        let fingerprint = canonical_json(&task)?;
        let mut state = self.state.lock().unwrap();
        if let Some(existing) = state.tasks.get(&task.task_id) {
            if existing.task.execution_id == task.execution_id && existing.task_fingerprint == fingerprint {
                return Ok(existing.clone());
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "task_id is already bound to a different execution or task payload",
            ));
        }
        if state
            .tasks
            .values()
            .any(|existing| existing.task.execution_id == task.execution_id)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "execution_id is already bound to another task",
            ));
        }

        let now = Utc::now();
        let record = TaskRecord {
            task: task.clone(),
            task_fingerprint: fingerprint,
            state: RemoteTaskState::Queued,
            sticky_node_id: None,
            fencing_token: 0,
            active_lease: None,
            last_event_sequence: 0,
            events: Vec::new(),
            terminal: None,
            delivery_fingerprints: BTreeMap::new(),
            created_at: now,
            updated_at: now,
        };
        self.persist_task(&record).map_err(ApiError::internal)?;
        state.tasks.insert(task.task_id.clone(), record.clone());
        Ok(record)
    }

    fn register_node(&self, node_id: &str, capabilities: Vec<String>) -> Result<NodeRecord, ApiError> {
        validate_id("node_id", node_id)?;
        require_capabilities(&capabilities)?;
        let now = Utc::now();
        let mut state = self.state.lock().unwrap();
        let registered_at = state
            .nodes
            .get(node_id)
            .map(|node| node.registered_at)
            .unwrap_or(now);
        let record = NodeRecord {
            node_id: node_id.to_string(),
            capabilities: normalized_capabilities(capabilities),
            registered_at,
            last_heartbeat_at: now,
            active_task_id: state.nodes.get(node_id).and_then(|node| node.active_task_id.clone()),
            pending_deliveries: state.nodes.get(node_id).map(|node| node.pending_deliveries).unwrap_or(0),
        };
        self.persist_node(&record).map_err(ApiError::internal)?;
        state.nodes.insert(node_id.to_string(), record.clone());
        Ok(record)
    }

    fn heartbeat(
        &self,
        node_id: &str,
        active_task_id: Option<String>,
        pending_deliveries: u64,
    ) -> Result<NodeRecord, ApiError> {
        validate_id("node_id", node_id)?;
        let mut state = self.state.lock().unwrap();
        let existing = state.nodes.get(node_id).cloned().ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "node must register before heartbeat")
        })?;
        let record = NodeRecord {
            last_heartbeat_at: Utc::now(),
            active_task_id,
            pending_deliveries,
            ..existing
        };
        self.persist_node(&record).map_err(ApiError::internal)?;
        state.nodes.insert(node_id.to_string(), record.clone());
        Ok(record)
    }

    fn try_lease(&self, node_id: &str, capabilities: &[String]) -> Result<Option<RemoteLease>, ApiError> {
        validate_id("node_id", node_id)?;
        require_capabilities(capabilities)?;
        let mut state = self.state.lock().unwrap();
        let registered = state.nodes.get(node_id).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "node must register before leasing tasks")
        })?;
        require_capabilities(&registered.capabilities)?;

        let now = Utc::now();
        let selected = state.tasks.iter().find_map(|(task_id, record)| {
            if record.state.is_terminal() || record.terminal.is_some() {
                return None;
            }
            if let Some(active) = &record.active_lease {
                if active.lease_expires_at > now {
                    return None;
                }
            }
            match &record.sticky_node_id {
                Some(sticky) if sticky != node_id => None,
                _ => Some(task_id.clone()),
            }
        });

        let Some(task_id) = selected else {
            return Ok(None);
        };
        let record = state.tasks.get_mut(&task_id).unwrap();
        let before = record.clone();
        record.fencing_token = record
            .fencing_token
            .checked_add(1)
            .ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "fencing token exhausted"))?;
        let lease = LeaseRecord {
            node_id: node_id.to_string(),
            lease_id: Uuid::new_v4().to_string(),
            fencing_token: record.fencing_token,
            lease_expires_at: now + self.lease_ttl,
        };
        if record.sticky_node_id.is_none() {
            record.sticky_node_id = Some(node_id.to_string());
        }
        record.active_lease = Some(lease.clone());
        record.state = RemoteTaskState::Leased;
        record.updated_at = now;
        if let Err(error) = self.persist_task(record) {
            *record = before;
            return Err(ApiError::internal(error));
        }
        Ok(Some(RemoteLease {
            lease_id: lease.lease_id,
            fencing_token: lease.fencing_token,
            lease_expires_at: lease.lease_expires_at.to_rfc3339(),
            task: record.task.clone(),
        }))
    }

    fn renew(&self, task_id: &str, node_id: &str, body: &RenewBody) -> Result<RemoteLease, ApiError> {
        validate_id("task_id", task_id)?;
        let mut state = self.state.lock().unwrap();
        let record = state.tasks.get_mut(task_id).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "remote task not found")
        })?;
        validate_lease(record, node_id, &record.task.execution_id, &body.lease_id, body.fencing_token)?;
        let before = record.clone();
        let now = Utc::now();
        let active = record.active_lease.as_mut().unwrap();
        active.lease_expires_at = now + self.lease_ttl;
        record.updated_at = now;
        let lease = active.clone();
        if let Err(error) = self.persist_task(record) {
            *record = before;
            return Err(ApiError::internal(error));
        }
        Ok(RemoteLease {
            lease_id: lease.lease_id,
            fencing_token: lease.fencing_token,
            lease_expires_at: lease.lease_expires_at.to_rfc3339(),
            task: record.task.clone(),
        })
    }

    fn accept_event(&self, task_id: &str, node_id: &str, body: EventEnvelope) -> Result<TaskRecord, ApiError> {
        validate_id("task_id", task_id)?;
        validate_id("delivery_id", &body.delivery_id)?;
        let fingerprint = canonical_json(&body)?;
        let mut state = self.state.lock().unwrap();
        let record = state.tasks.get_mut(task_id).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "remote task not found")
        })?;

        if let Some(previous) = record.delivery_fingerprints.get(&body.delivery_id) {
            if previous == &fingerprint {
                return Ok(record.clone());
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "delivery_id is already bound to different event content",
            ));
        }
        if record.state.is_terminal() || record.terminal.is_some() {
            return Err(ApiError::new(StatusCode::CONFLICT, "remote task is already terminal"));
        }
        validate_lease(
            record,
            node_id,
            &body.execution_id,
            &body.lease_id,
            body.fencing_token,
        )?;
        if body.event_sequence <= record.last_event_sequence {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "event_sequence must be strictly greater than the last accepted sequence",
            ));
        }

        let before = record.clone();
        record.last_event_sequence = body.event_sequence;
        record.events.push(AcceptedEvent {
            delivery_id: body.delivery_id.clone(),
            execution_id: body.execution_id,
            lease_id: body.lease_id,
            fencing_token: body.fencing_token,
            event_sequence: body.event_sequence,
            event_type: body.event_type.clone(),
            created_at: body.created_at,
            payload: body.payload,
        });
        if body.event_type == "host.accepted" {
            record.state = RemoteTaskState::Running;
        }
        record.delivery_fingerprints.insert(body.delivery_id, fingerprint);
        record.updated_at = Utc::now();
        if let Err(error) = self.persist_task(record) {
            *record = before;
            return Err(ApiError::internal(error));
        }
        Ok(record.clone())
    }

    fn accept_terminal(
        &self,
        task_id: &str,
        node_id: &str,
        body: TerminalEnvelope,
        route: TerminalRoute,
    ) -> Result<TaskRecord, ApiError> {
        validate_id("task_id", task_id)?;
        validate_id("delivery_id", &body.delivery_id)?;
        validate_terminal_route(body.state, route)?;
        let fingerprint = canonical_json(&body)?;
        let mut state = self.state.lock().unwrap();
        let record = state.tasks.get_mut(task_id).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "remote task not found")
        })?;

        if let Some(previous) = record.delivery_fingerprints.get(&body.delivery_id) {
            if previous == &fingerprint {
                return Ok(record.clone());
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "delivery_id is already bound to different terminal content",
            ));
        }
        if record.terminal.is_some() || record.state.is_terminal() {
            return Err(ApiError::new(StatusCode::CONFLICT, "remote task is already terminal"));
        }
        validate_lease(
            record,
            node_id,
            &body.execution_id,
            &body.lease_id,
            body.fencing_token,
        )?;

        let before = record.clone();
        record.state = body.state;
        record.terminal = Some(TerminalRecord {
            delivery_id: body.delivery_id.clone(),
            execution_id: body.execution_id,
            lease_id: body.lease_id,
            fencing_token: body.fencing_token,
            created_at: body.created_at,
            state: body.state,
            result: body.result,
        });
        record.delivery_fingerprints.insert(body.delivery_id, fingerprint);
        record.active_lease = None;
        record.updated_at = Utc::now();
        if let Err(error) = self.persist_task(record) {
            *record = before;
            return Err(ApiError::internal(error));
        }
        Ok(record.clone())
    }

    fn task(&self, task_id: &str) -> Result<TaskRecord, ApiError> {
        validate_id("task_id", task_id)?;
        self.state
            .lock()
            .unwrap()
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "remote task not found"))
    }

    fn tasks(&self) -> Vec<TaskRecord> {
        self.state.lock().unwrap().tasks.values().cloned().collect()
    }

    fn nodes(&self) -> Vec<NodeRecord> {
        self.state.lock().unwrap().nodes.values().cloned().collect()
    }

    fn persist_task(&self, record: &TaskRecord) -> anyhow::Result<()> {
        write_json_atomic(&self.root.join("tasks").join(format!("{}.json", record.task.task_id)), record)
    }

    fn persist_node(&self, record: &NodeRecord) -> anyhow::Result<()> {
        write_json_atomic(&self.root.join("nodes").join(format!("{}.json", record.node_id)), record)
    }
}

#[derive(Clone, Copy)]
enum AuthRole {
    Host,
    Control,
}

#[derive(Clone, Copy)]
enum TerminalRoute {
    Complete,
    Fail,
    Blocked,
}

fn require_runtime(runtime: &RemoteControlRuntime, headers: &HeaderMap, role: AuthRole) -> Result<Arc<ControlPlane>, ApiError> {
    let plane = runtime.plane.clone().ok_or_else(|| {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "remote control plane is not configured")
    })?;
    let auth = runtime.auth.as_ref().ok_or_else(|| {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "remote control plane is not configured")
    })?;
    let expected = match role {
        AuthRole::Host => &auth.host_token,
        AuthRole::Control => &auth.control_token,
    };
    let supplied = bearer_token(headers).ok_or_else(|| {
        ApiError::new(StatusCode::UNAUTHORIZED, "missing bearer token")
    })?;
    if supplied != expected {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid bearer token"));
    }
    Ok(plane)
}

fn host_node_id(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get("x-zero3-node-id")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "missing x-zero3-node-id header"))?
        .to_str()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid x-zero3-node-id header"))?;
    validate_id("x-zero3-node-id", value)?;
    Ok(value.to_string())
}

async fn register_node(
    State(runtime): State<RemoteControlRuntime>,
    headers: HeaderMap,
    Json(body): Json<NodeRegisterBody>,
) -> Result<Json<NodeRecord>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let header_node = host_node_id(&headers)?;
    if header_node != body.node_id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "node header/body identity mismatch"));
    }
    Ok(Json(plane.register_node(&body.node_id, body.capabilities)?))
}

async fn heartbeat_node(
    State(runtime): State<RemoteControlRuntime>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<HeartbeatBody>,
) -> Result<Json<NodeRecord>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let header_node = host_node_id(&headers)?;
    if header_node != node_id || body.node_id != node_id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "node path/header/body identity mismatch"));
    }
    Ok(Json(plane.heartbeat(
        &node_id,
        body.active_task_id,
        body.pending_deliveries.unwrap_or(0),
    )?))
}

async fn lease_task(
    State(runtime): State<RemoteControlRuntime>,
    headers: HeaderMap,
    Json(body): Json<LeaseRequest>,
) -> Result<Json<Option<RemoteLease>>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let header_node = host_node_id(&headers)?;
    if header_node != body.node_id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "node header/body identity mismatch"));
    }
    let wait_seconds = body.wait_seconds.unwrap_or(1).clamp(1, MAX_LONG_POLL_SECONDS);
    let deadline = Instant::now() + StdDuration::from_secs(wait_seconds);
    loop {
        if let Some(lease) = plane.try_lease(&body.node_id, &body.capabilities)? {
            return Ok(Json(Some(lease)));
        }
        if Instant::now() >= deadline {
            return Ok(Json(None));
        }
        sleep(StdDuration::from_millis(LONG_POLL_INTERVAL_MS)).await;
    }
}

async fn renew_task(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RenewBody>,
) -> Result<Json<RemoteLease>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let header_node = host_node_id(&headers)?;
    if header_node != body.node_id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "node header/body identity mismatch"));
    }
    Ok(Json(plane.renew(&task_id, &header_node, &body)?))
}

async fn accept_event(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<EventEnvelope>,
) -> Result<Json<Value>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let node_id = host_node_id(&headers)?;
    let record = plane.accept_event(&task_id, &node_id, body)?;
    Ok(Json(json!({
        "accepted": true,
        "task_id": record.task.task_id,
        "state": record.state,
        "last_event_sequence": record.last_event_sequence,
    })))
}

async fn complete_task(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalEnvelope>,
) -> Result<Json<Value>, ApiError> {
    terminal_handler(runtime, task_id, headers, body, TerminalRoute::Complete)
}

async fn fail_task(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalEnvelope>,
) -> Result<Json<Value>, ApiError> {
    terminal_handler(runtime, task_id, headers, body, TerminalRoute::Fail)
}

async fn block_task(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalEnvelope>,
) -> Result<Json<Value>, ApiError> {
    terminal_handler(runtime, task_id, headers, body, TerminalRoute::Blocked)
}

fn terminal_handler(
    runtime: RemoteControlRuntime,
    task_id: String,
    headers: HeaderMap,
    body: TerminalEnvelope,
    route: TerminalRoute,
) -> Result<Json<Value>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Host)?;
    let node_id = host_node_id(&headers)?;
    let record = plane.accept_terminal(&task_id, &node_id, body, route)?;
    Ok(Json(json!({
        "accepted": true,
        "task_id": record.task.task_id,
        "state": record.state,
    })))
}

async fn create_task(
    State(runtime): State<RemoteControlRuntime>,
    headers: HeaderMap,
    Json(task): Json<RemoteTask>,
) -> Result<(StatusCode, Json<TaskRecord>), ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Control)?;
    let existed = plane.state.lock().unwrap().tasks.contains_key(&task.task_id);
    let record = plane.create_task(task)?;
    Ok((if existed { StatusCode::OK } else { StatusCode::CREATED }, Json(record)))
}

async fn get_task(
    State(runtime): State<RemoteControlRuntime>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<TaskRecord>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Control)?;
    Ok(Json(plane.task(&task_id)?))
}

async fn list_tasks(
    State(runtime): State<RemoteControlRuntime>,
    headers: HeaderMap,
) -> Result<Json<Vec<TaskRecord>>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Control)?;
    Ok(Json(plane.tasks()))
}

async fn list_nodes(
    State(runtime): State<RemoteControlRuntime>,
    headers: HeaderMap,
) -> Result<Json<Vec<NodeRecord>>, ApiError> {
    let plane = require_runtime(&runtime, &headers, AuthRole::Control)?;
    Ok(Json(plane.nodes()))
}

fn validate_task(task: &RemoteTask) -> Result<(), ApiError> {
    if task.protocol != REMOTE_TASK_PROTOCOL {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "unsupported remote task protocol"));
    }
    validate_id("task_id", &task.task_id)?;
    validate_id("execution_id", &task.execution_id)?;
    if task.objective.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "objective must not be empty"));
    }
    if task.target.workspace.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "target.workspace must not be empty"));
    }
    Ok(())
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

fn require_capabilities(capabilities: &[String]) -> Result<(), ApiError> {
    let set: BTreeSet<&str> = capabilities.iter().map(String::as_str).collect();
    for required in REQUIRED_HOST_CAPABILITIES {
        if !set.contains(required) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("host is missing required capability: {required}"),
            ));
        }
    }
    Ok(())
}

fn normalized_capabilities(capabilities: Vec<String>) -> Vec<String> {
    capabilities.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

fn validate_lease(
    record: &TaskRecord,
    node_id: &str,
    execution_id: &str,
    lease_id: &str,
    fencing_token: u64,
) -> Result<(), ApiError> {
    if record.task.execution_id != execution_id {
        return Err(ApiError::new(StatusCode::CONFLICT, "execution_id does not match task"));
    }
    let active = record.active_lease.as_ref().ok_or_else(|| {
        ApiError::new(StatusCode::GONE, "remote task has no active lease")
    })?;
    if active.node_id != node_id || active.lease_id != lease_id {
        return Err(ApiError::new(StatusCode::GONE, "remote task lease is stale"));
    }
    if active.fencing_token != fencing_token || record.fencing_token != fencing_token {
        return Err(ApiError::new(StatusCode::PRECONDITION_FAILED, "remote task fencing token is stale"));
    }
    if active.lease_expires_at <= Utc::now() {
        return Err(ApiError::new(StatusCode::GONE, "remote task lease has expired"));
    }
    Ok(())
}

fn validate_terminal_route(state: RemoteTaskState, route: TerminalRoute) -> Result<(), ApiError> {
    let valid = match route {
        TerminalRoute::Complete => state == RemoteTaskState::Succeeded,
        TerminalRoute::Blocked => state == RemoteTaskState::Blocked,
        TerminalRoute::Fail => matches!(
            state,
            RemoteTaskState::Failed
                | RemoteTaskState::Cancelled
                | RemoteTaskState::OutcomeUnknown
                | RemoteTaskState::Quarantined
        ),
    };
    if valid {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "terminal state does not match endpoint",
        ))
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn canonical_json<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value).map_err(ApiError::internal)
}

fn read_secret_file(path: &str) -> anyhow::Result<String> {
    let secret = fs::read_to_string(path)?.trim().to_string();
    if secret.is_empty() {
        anyhow::bail!("secret file is empty: {path}");
    }
    Ok(secret)
}

fn json_files(dir: &FsPath) -> anyhow::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn write_json_atomic<T: Serialize>(path: &FsPath, value: &T) -> anyhow::Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("state path has invalid filename"))?;
    let temporary = parent.join(format!(".{file_name}.tmp-{}", Uuid::new_v4()));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn task(task_id: &str, execution_id: &str) -> RemoteTask {
        RemoteTask {
            protocol: REMOTE_TASK_PROTOCOL.to_string(),
            task_id: task_id.to_string(),
            execution_id: execution_id.to_string(),
            objective: "verify remote control plane".to_string(),
            target: RemoteTaskTarget {
                workspace: r"C:\workspace".to_string(),
                base_ref: None,
            },
            constraints: None,
            acceptance_criteria: None,
            permission_profile: Some("read_only".to_string()),
            execution: None,
        }
    }

    fn caps() -> Vec<String> {
        vec!["codex".into(), "thread".into(), "turn".into(), "git".into()]
    }

    #[test]
    fn exact_task_identity_is_idempotent_and_conflicts_on_payload_change() {
        let dir = tempfile::tempdir().unwrap();
        let plane = ControlPlane::open(dir.path().to_path_buf()).unwrap();
        let first = plane.create_task(task("task-a", "exec-a")).unwrap();
        let same = plane.create_task(task("task-a", "exec-a")).unwrap();
        assert_eq!(first.task_fingerprint, same.task_fingerprint);

        let mut changed = task("task-a", "exec-a");
        changed.objective = "different objective".into();
        let error = plane.create_task(changed).unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
    }

    #[test]
    fn expired_lease_is_sticky_to_original_node_and_increments_fencing() {
        let dir = tempfile::tempdir().unwrap();
        let plane = ControlPlane::open_with_ttl(dir.path().to_path_buf(), Duration::milliseconds(10)).unwrap();
        plane.register_node("node-a", caps()).unwrap();
        plane.register_node("node-b", caps()).unwrap();
        plane.create_task(task("task-a", "exec-a")).unwrap();

        let first = plane.try_lease("node-a", &caps()).unwrap().unwrap();
        assert_eq!(first.fencing_token, 1);
        std::thread::sleep(StdDuration::from_millis(20));
        assert!(plane.try_lease("node-b", &caps()).unwrap().is_none());
        let second = plane.try_lease("node-a", &caps()).unwrap().unwrap();
        assert_eq!(second.fencing_token, 2);
        assert_ne!(first.lease_id, second.lease_id);
    }

    #[test]
    fn delivery_replay_is_idempotent_sequence_can_skip_and_state_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let plane = ControlPlane::open(root.clone()).unwrap();
        plane.register_node("node-a", caps()).unwrap();
        plane.create_task(task("task-a", "exec-a")).unwrap();
        let lease = plane.try_lease("node-a", &caps()).unwrap().unwrap();

        let accepted = EventEnvelope {
            delivery_id: "delivery-1".into(),
            execution_id: "exec-a".into(),
            lease_id: lease.lease_id.clone(),
            fencing_token: lease.fencing_token,
            event_sequence: 1,
            event_type: "host.accepted".into(),
            created_at: Utc::now().to_rfc3339(),
            payload: json!({"node_id":"node-a"}),
        };
        plane.accept_event("task-a", "node-a", accepted.clone()).unwrap();
        plane.accept_event("task-a", "node-a", accepted).unwrap();

        let skipped = EventEnvelope {
            delivery_id: "delivery-3".into(),
            execution_id: "exec-a".into(),
            lease_id: lease.lease_id.clone(),
            fencing_token: lease.fencing_token,
            event_sequence: 3,
            event_type: "codex.turn.completed".into(),
            created_at: Utc::now().to_rfc3339(),
            payload: json!({"status":"completed"}),
        };
        plane.accept_event("task-a", "node-a", skipped).unwrap();

        let terminal = TerminalEnvelope {
            delivery_id: "delivery-terminal".into(),
            execution_id: "exec-a".into(),
            lease_id: lease.lease_id,
            fencing_token: lease.fencing_token,
            created_at: Utc::now().to_rfc3339(),
            state: RemoteTaskState::Succeeded,
            result: json!({"summary":"done"}),
        };
        plane
            .accept_terminal("task-a", "node-a", terminal.clone(), TerminalRoute::Complete)
            .unwrap();
        plane
            .accept_terminal("task-a", "node-a", terminal, TerminalRoute::Complete)
            .unwrap();
        drop(plane);

        let reopened = ControlPlane::open(root).unwrap();
        let record = reopened.task("task-a").unwrap();
        assert_eq!(record.state, RemoteTaskState::Succeeded);
        assert_eq!(record.last_event_sequence, 3);
        assert_eq!(record.events.len(), 2);
        assert!(record.terminal.is_some());
        assert_eq!(record.delivery_fingerprints.len(), 3);
    }

    #[tokio::test]
    async fn http_contract_matches_remote_host_endpoints_and_auth() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = RemoteControlRuntime::test(
            dir.path().to_path_buf(),
            "host-secret",
            "control-secret",
            Duration::seconds(45),
        )
        .unwrap();
        let app = router(runtime);

        let task_body = serde_json::to_vec(&task("task-http", "exec-http")).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/v1/tasks")
                    .header("authorization", "Bearer control-secret")
                    .header("content-type", "application/json")
                    .body(Body::from(task_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let register = json!({"node_id":"node-http","capabilities":caps()});
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/host/v1/nodes/register")
                    .header("authorization", "Bearer host-secret")
                    .header("x-zero3-node-id", "node-http")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&register).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let lease = json!({"node_id":"node-http","wait_seconds":1,"capabilities":caps()});
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/host/v1/tasks/lease")
                    .header("authorization", "Bearer host-secret")
                    .header("x-zero3-node-id", "node-http")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&lease).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
