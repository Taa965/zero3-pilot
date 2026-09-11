use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::{sleep, Instant};
use uuid::Uuid;

use crate::oauth::OAuthServer;

const DEFAULT_LEASE_TTL_SECONDS: i64 = 30;
const DEFAULT_REQUEST_TTL_SECONDS: i64 = 120;
const SKILL_LEASE_TTL_SECONDS: i64 = 15 * 60;
const SKILL_REQUEST_TTL_SECONDS: i64 = 20 * 60;
const DEFAULT_MCP_WAIT_SECONDS: u64 = 28;
const MAX_LONG_POLL_SECONDS: u64 = 30;
const LONG_POLL_INTERVAL_MS: u64 = 200;
const MAX_ACTIVE_REQUESTS: usize = 1024;
const MAX_WORKER_GATEWAY_BODY_BYTES: usize = 2 * 1024 * 1024;
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_MCP_PROTOCOL_VERSIONS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];
const BUILT_WORKER_OAUTH_ISSUER: Option<&str> = option_env!("ZERO3_WORKER_OAUTH_ISSUER_BUILD");
const WORKER_CAPABILITY: &str = "worker-protocol-v1";
const SKILL_CAPABILITY: &str = "codex-native-skills-v1";
const REMOTE_CAPABILITY: &str = "zero3-capability-v1";
const CAPABILITY_TOOLS: [&str; 5] = [
    "list_capabilities",
    "describe_capability",
    "invoke_capability",
    "get_operation",
    "cancel_operation",
];
const SKILL_TOOLS: [&str; 4] = ["list_skills", "search_skills", "get_skill", "invoke_skill"];
const WORKER_TOOLS: [&str; 21] = [
    "register_worker",
    "claim_work",
    "report_progress",
    "complete_and_claim_next",
    "report_failure",
    "get_task_context",
    "session_start",
    "context_resolve",
    "task_claim",
    "event_record",
    "artifact_register",
    "task_complete",
    "memory_commit",
    "handoff_create",
    "task_bootstrap",
    "dispatch_codex_task",
    "verify_commit",
    "bootstrap_worker",
    "commit_and_claim_next",
    "report_blocked",
    "recover_worker",
];
#[derive(Clone)]
pub struct WorkerGatewayRuntime {
    gateway: Option<Arc<WorkerGateway>>,
    host_token: Option<Arc<String>>,
    mcp_token: Option<Arc<String>>,
    skill_mcp_token: Option<Arc<String>>,
    oauth: Option<Arc<OAuthServer>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WorkerRequestState {
    Queued,
    Leased,
    Completed,
    Failed,
    Expired,
}

impl WorkerRequestState {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Expired)
    }
}

fn default_worker_capability() -> String {
    WORKER_CAPABILITY.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerRpcRecord {
    request_id: String,
    #[serde(default = "default_worker_capability")]
    capability: String,
    target_node_id: String,
    tool: String,
    arguments: Value,
    fingerprint: String,
    dedupe_key: Option<String>,
    state: WorkerRequestState,
    lease_id: Option<String>,
    fencing_token: u64,
    lease_expires_at: Option<DateTime<Utc>>,
    result: Option<Value>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize)]
struct WorkerRpcLease {
    request_id: String,
    capability: String,
    lease_id: String,
    fencing_token: u64,
    lease_expires_at: String,
    tool: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct WorkerLeaseBody {
    node_id: String,
    #[serde(default)]
    wait_seconds: Option<u64>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WorkerCompleteBody {
    node_id: String,
    lease_id: String,
    fencing_token: u64,
    result: Value,
}

#[derive(Debug, Deserialize)]
struct WorkerFailBody {
    node_id: String,
    lease_id: String,
    fencing_token: u64,
    error: String,
}

#[derive(Default)]
struct WorkerGatewayState {
    requests: BTreeMap<String, WorkerRpcRecord>,
}

struct WorkerGateway {
    root: PathBuf,
    target_node_id: String,
    lease_ttl: Duration,
    request_ttl: Duration,
    state: Mutex<WorkerGatewayState>,
}
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
    headers: HeaderMap,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            headers: HeaderMap::new(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("worker gateway persistence failure: {error}"),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            self.headers,
            Json(json!({ "error": self.message })),
        )
            .into_response()
    }
}

impl WorkerGatewayRuntime {
    pub fn from_env() -> anyhow::Result<Self> {
        let enabled = parse_bool(
            std::env::var("ZERO3_WORKER_GATEWAY_ENABLED")
                .ok()
                .as_deref(),
        );
        if !enabled {
            return Ok(Self {
                gateway: None,
                host_token: None,
                mcp_token: None,
                skill_mcp_token: None,
                oauth: None,
            });
        }
        let host_file = required_env("ZERO3_HOST_TOKEN_FILE")?;
        let mcp_token = optional_secret_file("ZERO3_WORKER_MCP_TOKEN_FILE")?.map(Arc::new);
        let skill_mcp_token = optional_secret_file("ZERO3_SKILL_MCP_TOKEN_FILE")?.map(Arc::new);
        let oauth_issuer = resolve_oauth_issuer(
            parse_bool(std::env::var("ZERO3_WORKER_OAUTH_ENABLED").ok().as_deref()),
            std::env::var("ZERO3_WORKER_OAUTH_ISSUER").ok().as_deref(),
            BUILT_WORKER_OAUTH_ISSUER,
        )?;
        let target_node_id = required_env("ZERO3_WORKER_GATEWAY_NODE_ID")?;
        validate_id("ZERO3_WORKER_GATEWAY_NODE_ID", &target_node_id)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let root = std::env::var("ZERO3_WORKER_GATEWAY_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/var/lib/zero3-pilot/worker-gateway"));
        let oauth = if let Some(issuer) = oauth_issuer {
            let owner_file = std::env::var("ZERO3_WORKER_OAUTH_OWNER_SECRET_FILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("ZERO3_WORKER_MCP_TOKEN_FILE")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .ok_or_else(|| anyhow::anyhow!(
                    "ZERO3_WORKER_OAUTH_OWNER_SECRET_FILE or ZERO3_WORKER_MCP_TOKEN_FILE is required when Worker OAuth is enabled"
                ))?;
            let owner_secret = read_secret_file(owner_file.trim())?;
            Some(Arc::new(OAuthServer::open(
                root.join("oauth"),
                issuer,
                &owner_secret,
            )?))
        } else {
            None
        };
        if mcp_token.is_none() && oauth.is_none() && skill_mcp_token.is_none() {
            anyhow::bail!("Worker OAuth, ZERO3_WORKER_MCP_TOKEN_FILE, or ZERO3_SKILL_MCP_TOKEN_FILE is required when Zero3 RPC Gateway is enabled");
        }
        Ok(Self {
            gateway: Some(Arc::new(WorkerGateway::open(root, target_node_id)?)),
            host_token: Some(Arc::new(read_secret_file(&host_file)?)),
            mcp_token,
            skill_mcp_token,
            oauth,
        })
    }

    fn gateway(&self) -> Result<Arc<WorkerGateway>, ApiError> {
        self.gateway.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "worker gateway is not configured",
            )
        })
    }
}

pub fn router(runtime: WorkerGatewayRuntime) -> Router {
    let oauth_router = crate::oauth::router(runtime.oauth.clone());
    Router::new()
        .route("/mcp", post(mcp_handler))
        .route("/mcp/skills", post(skill_mcp_handler))
        .route("/api/host/v1/worker-rpc/lease", post(worker_lease))
        .route(
            "/api/host/v1/worker-rpc/:request_id/complete",
            post(worker_complete),
        )
        .route(
            "/api/host/v1/worker-rpc/:request_id/fail",
            post(worker_fail),
        )
        .layer(DefaultBodyLimit::max(MAX_WORKER_GATEWAY_BODY_BYTES))
        .with_state(runtime)
        .merge(oauth_router)
}

impl WorkerGateway {
    fn open(root: PathBuf, target_node_id: String) -> anyhow::Result<Self> {
        let requests_dir = root.join("requests");
        fs::create_dir_all(&requests_dir)?;
        let mut state = WorkerGatewayState::default();
        for path in json_files(&requests_dir)? {
            let record: WorkerRpcRecord = serde_json::from_slice(&fs::read(&path)?)?;
            validate_id("persisted worker request_id", &record.request_id)
                .map_err(|error| anyhow::anyhow!(error.message))?;
            state.requests.insert(record.request_id.clone(), record);
        }
        Ok(Self {
            root,
            target_node_id,
            lease_ttl: Duration::seconds(DEFAULT_LEASE_TTL_SECONDS),
            request_ttl: Duration::seconds(DEFAULT_REQUEST_TTL_SECONDS),
            state: Mutex::new(state),
        })
    }
    fn submit(&self, tool: &str, arguments: Value) -> Result<WorkerRpcRecord, ApiError> {
        self.submit_for(WORKER_CAPABILITY, tool, arguments)
    }

    fn submit_for(
        &self,
        capability: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<WorkerRpcRecord, ApiError> {
        validate_tool_for(capability, tool)?;
        if !arguments.is_object() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "worker tool arguments must be an object",
            ));
        }
        let fingerprint = serde_json::to_string(&arguments).map_err(ApiError::internal)?;
        let dedupe_key = request_dedupe_key(capability, tool, &arguments);
        let mut state = self.state.lock().unwrap();
        self.refresh_locked(&mut state)?;
        if let Some(key) = &dedupe_key {
            if let Some(existing) = state
                .requests
                .values()
                .find(|record| record.dedupe_key.as_ref() == Some(key))
            {
                if existing.fingerprint == fingerprint {
                    return Ok(existing.clone());
                }
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "worker idempotency key was reused with different arguments",
                ));
            }
        }
        let active = state
            .requests
            .values()
            .filter(|record| !record.state.is_terminal())
            .count();
        if active >= MAX_ACTIVE_REQUESTS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "worker gateway queue is full",
            ));
        }
        let now = Utc::now();
        let record = WorkerRpcRecord {
            request_id: format!(
                "{}-{}",
                if capability == SKILL_CAPABILITY {
                    "srpc"
                } else if capability == REMOTE_CAPABILITY {
                    "crpc"
                } else {
                    "wrpc"
                },
                Uuid::new_v4()
            ),
            capability: capability.to_string(),
            target_node_id: self.target_node_id.clone(),
            tool: tool.to_string(),
            arguments,
            fingerprint,
            dedupe_key,
            state: WorkerRequestState::Queued,
            lease_id: None,
            fencing_token: 0,
            lease_expires_at: None,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: now
                + if capability == SKILL_CAPABILITY || tool == "verify_commit" {
                    Duration::seconds(SKILL_REQUEST_TTL_SECONDS)
                } else {
                    self.request_ttl
                },
        };
        self.persist(&record).map_err(ApiError::internal)?;
        state
            .requests
            .insert(record.request_id.clone(), record.clone());
        Ok(record)
    }
    fn try_lease(&self, node_id: &str) -> Result<Option<WorkerRpcLease>, ApiError> {
        self.try_lease_for(node_id, &[WORKER_CAPABILITY.to_string()])
    }

    fn try_lease_for(
        &self,
        node_id: &str,
        capabilities: &[String],
    ) -> Result<Option<WorkerRpcLease>, ApiError> {
        if node_id != self.target_node_id {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "worker RPC is bound to a different Zero3 node",
            ));
        }
        let mut state = self.state.lock().unwrap();
        self.refresh_locked(&mut state)?;
        let candidate = state
            .requests
            .values()
            .filter(|record| {
                record.state == WorkerRequestState::Queued
                    && record.target_node_id == node_id
                    && capabilities
                        .iter()
                        .any(|capability| capability == &record.capability)
            })
            .min_by_key(|record| (record.created_at, record.request_id.clone()))
            .map(|record| record.request_id.clone());
        let Some(request_id) = candidate else {
            return Ok(None);
        };
        let mut record = state
            .requests
            .get(&request_id)
            .cloned()
            .expect("candidate exists");
        record.state = WorkerRequestState::Leased;
        record.lease_id = Some(format!("wrpc-lease-{}", Uuid::new_v4()));
        record.fencing_token = record.fencing_token.checked_add(1).ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "worker RPC fencing token overflow",
            )
        })?;
        record.lease_expires_at = Some(
            Utc::now()
                + if record.capability == SKILL_CAPABILITY || record.tool == "verify_commit" {
                    Duration::seconds(SKILL_LEASE_TTL_SECONDS)
                } else {
                    self.lease_ttl
                },
        );
        record.updated_at = Utc::now();
        self.persist(&record).map_err(ApiError::internal)?;
        state.requests.insert(request_id, record.clone());
        Ok(Some(WorkerRpcLease {
            request_id: record.request_id,
            capability: record.capability,
            lease_id: record.lease_id.expect("lease set"),
            fencing_token: record.fencing_token,
            lease_expires_at: record
                .lease_expires_at
                .expect("lease expiry set")
                .to_rfc3339(),
            tool: record.tool,
            arguments: record.arguments,
        }))
    }
    fn complete(
        &self,
        request_id: &str,
        node_id: &str,
        lease_id: &str,
        fencing_token: u64,
        result: Value,
    ) -> Result<WorkerRpcRecord, ApiError> {
        self.finish(
            request_id,
            node_id,
            lease_id,
            fencing_token,
            Some(result),
            None,
            WorkerRequestState::Completed,
        )
    }

    fn fail(
        &self,
        request_id: &str,
        node_id: &str,
        lease_id: &str,
        fencing_token: u64,
        error: String,
    ) -> Result<WorkerRpcRecord, ApiError> {
        let detail = error.trim();
        if detail.is_empty() || detail.len() > 4096 {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "worker RPC error must be 1..4096 characters",
            ));
        }
        self.finish(
            request_id,
            node_id,
            lease_id,
            fencing_token,
            None,
            Some(detail.to_string()),
            WorkerRequestState::Failed,
        )
    }

    fn finish(
        &self,
        request_id: &str,
        node_id: &str,
        lease_id: &str,
        fencing_token: u64,
        result: Option<Value>,
        error: Option<String>,
        state_value: WorkerRequestState,
    ) -> Result<WorkerRpcRecord, ApiError> {
        validate_id("worker request_id", request_id)?;
        let mut state = self.state.lock().unwrap();
        self.refresh_locked(&mut state)?;
        let mut record =
            state.requests.get(request_id).cloned().ok_or_else(|| {
                ApiError::new(StatusCode::NOT_FOUND, "worker RPC request not found")
            })?;
        if record.state.is_terminal() {
            if record.state == state_value && record.result == result && record.error == error {
                return Ok(record);
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "worker RPC is already terminal with a different outcome",
            ));
        }
        validate_active_lease(&record, node_id, lease_id, fencing_token)?;
        record.state = state_value;
        record.result = result;
        record.error = error;
        record.updated_at = Utc::now();
        record.lease_expires_at = None;
        self.persist(&record).map_err(ApiError::internal)?;
        state
            .requests
            .insert(request_id.to_string(), record.clone());
        Ok(record)
    }
    fn get(&self, request_id: &str) -> Result<WorkerRpcRecord, ApiError> {
        let mut state = self.state.lock().unwrap();
        self.refresh_locked(&mut state)?;
        state
            .requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "worker RPC request not found"))
    }

    fn refresh_locked(&self, state: &mut WorkerGatewayState) -> Result<(), ApiError> {
        let now = Utc::now();
        let ids: Vec<String> = state.requests.keys().cloned().collect();
        for id in ids {
            let mut record = state.requests.get(&id).cloned().expect("request exists");
            if record.state.is_terminal() && record.expires_at <= now {
                let path = self
                    .root
                    .join("requests")
                    .join(format!("{}.json", record.request_id));
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(ApiError::internal(error)),
                }
                state.requests.remove(&id);
                continue;
            }
            let before = record.state;
            if !record.state.is_terminal() && record.expires_at <= now {
                record.state = WorkerRequestState::Expired;
                record.error = Some("worker RPC request expired before completion".into());
                record.lease_id = None;
                record.lease_expires_at = None;
                record.updated_at = now;
            } else if record.state == WorkerRequestState::Leased
                && record.lease_expires_at.is_some_and(|at| at <= now)
            {
                record.state = WorkerRequestState::Queued;
                record.lease_id = None;
                record.lease_expires_at = None;
                record.updated_at = now;
            }
            if record.state != before {
                self.persist(&record).map_err(ApiError::internal)?;
                state.requests.insert(id, record);
            }
        }
        Ok(())
    }

    fn persist(&self, record: &WorkerRpcRecord) -> anyhow::Result<()> {
        write_json_atomic(
            &self
                .root
                .join("requests")
                .join(format!("{}.json", record.request_id)),
            record,
        )
    }
}
async fn worker_lease(
    State(runtime): State<WorkerGatewayRuntime>,
    headers: HeaderMap,
    Json(body): Json<WorkerLeaseBody>,
) -> Result<Json<Option<WorkerRpcLease>>, ApiError> {
    require_host(&runtime, &headers, &body.node_id)?;
    if !body.capabilities.iter().any(|capability| {
        capability == WORKER_CAPABILITY
            || capability == SKILL_CAPABILITY
            || capability == REMOTE_CAPABILITY
    }) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "a supported worker RPC capability is required",
        ));
    }
    let gateway = runtime.gateway()?;
    let wait_seconds = body
        .wait_seconds
        .unwrap_or(1)
        .clamp(1, MAX_LONG_POLL_SECONDS);
    let deadline = Instant::now() + StdDuration::from_secs(wait_seconds);
    loop {
        if let Some(lease) = gateway.try_lease_for(&body.node_id, &body.capabilities)? {
            return Ok(Json(Some(lease)));
        }
        if Instant::now() >= deadline {
            return Ok(Json(None));
        }
        sleep(StdDuration::from_millis(LONG_POLL_INTERVAL_MS)).await;
    }
}

async fn worker_complete(
    State(runtime): State<WorkerGatewayRuntime>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<WorkerCompleteBody>,
) -> Result<Json<Value>, ApiError> {
    require_host(&runtime, &headers, &body.node_id)?;
    let record = runtime.gateway()?.complete(
        &request_id,
        &body.node_id,
        &body.lease_id,
        body.fencing_token,
        body.result,
    )?;
    Ok(Json(
        json!({"accepted": true, "request_id": record.request_id, "state": record.state}),
    ))
}

async fn worker_fail(
    State(runtime): State<WorkerGatewayRuntime>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<WorkerFailBody>,
) -> Result<Json<Value>, ApiError> {
    require_host(&runtime, &headers, &body.node_id)?;
    let record = runtime.gateway()?.fail(
        &request_id,
        &body.node_id,
        &body.lease_id,
        body.fencing_token,
        body.error,
    )?;
    Ok(Json(
        json!({"accepted": true, "request_id": record.request_id, "state": record.state}),
    ))
}
async fn mcp_handler(
    State(runtime): State<WorkerGatewayRuntime>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    require_mcp(&runtime, &headers)?;
    validate_mcp_origin(&headers)?;
    validate_mcp_protocol_header(&headers)?;
    let request = body.as_object().ok_or_else(|| {
        ApiError::new(StatusCode::BAD_REQUEST, "MCP request must be a JSON object")
    })?;
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Ok(mcp_error(
            request.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "Invalid Request",
        ));
    }
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let requested = request
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str);
            let protocol = requested
                .filter(|version| SUPPORTED_MCP_PROTOCOL_VERSIONS.contains(version))
                .unwrap_or(MCP_PROTOCOL_VERSION);
            Ok(mcp_result(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "zero3-web-worker", "version": env!("CARGO_PKG_VERSION")}
                }),
            ))
        }
        "notifications/initialized" | "notifications/cancelled" => {
            Ok(StatusCode::ACCEPTED.into_response())
        }
        "ping" => Ok(mcp_result(id, json!({}))),
        "tools/list" => Ok(mcp_result(id, json!({"tools": mcp_tool_catalog()}))),
        "tools/call" => mcp_call_tool(runtime, id, request.get("params")).await,
        _ => Ok(mcp_error(id, -32601, "Method not found")),
    }
}
async fn mcp_call_tool(
    runtime: WorkerGatewayRuntime,
    id: Value,
    params: Option<&Value>,
) -> Result<Response, ApiError> {
    let params = params.and_then(Value::as_object).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "tools/call params must be an object",
        )
    })?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "tools/call name is required"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let gateway = runtime.gateway()?;
    let protocol = if CAPABILITY_TOOLS.contains(&name) {
        REMOTE_CAPABILITY
    } else {
        WORKER_CAPABILITY
    };
    let submitted = gateway.submit_for(protocol, name, arguments)?;
    let deadline = Instant::now() + StdDuration::from_secs(DEFAULT_MCP_WAIT_SECONDS);
    loop {
        let current = gateway.get(&submitted.request_id)?;
        match current.state {
            WorkerRequestState::Completed => {
                let result = current.result.unwrap_or_else(|| json!({}));
                let text = serde_json::to_string(&result).map_err(ApiError::internal)?;
                return Ok(mcp_result(
                    id,
                    json!({
                        "content": [{"type": "text", "text": text}],
                        "structuredContent": result
                    }),
                ));
            }
            WorkerRequestState::Failed | WorkerRequestState::Expired => {
                let error = current
                    .error
                    .unwrap_or_else(|| "Zero3 worker RPC failed".into());
                return Ok(mcp_result(
                    id,
                    json!({
                        "content": [{"type": "text", "text": error}], "isError": true
                    }),
                ));
            }
            WorkerRequestState::Queued | WorkerRequestState::Leased => {}
        }
        if Instant::now() >= deadline {
            return Ok(mcp_result(
                id,
                json!({
                    "content": [{"type": "text", "text": "Zero3 local worker did not answer before the gateway timeout. Retry with the same idempotencyKey."}],
                    "isError": true
                }),
            ));
        }
        sleep(StdDuration::from_millis(LONG_POLL_INTERVAL_MS)).await;
    }
}
async fn skill_mcp_handler(
    State(runtime): State<WorkerGatewayRuntime>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    require_skill_mcp(&runtime, &headers)?;
    validate_mcp_origin(&headers)?;
    validate_mcp_protocol_header(&headers)?;
    let request = body.as_object().ok_or_else(|| {
        ApiError::new(StatusCode::BAD_REQUEST, "MCP request must be a JSON object")
    })?;
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Ok(mcp_error(
            request.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "Invalid Request",
        ));
    }
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let requested = request
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str);
            let protocol = requested
                .filter(|version| SUPPORTED_MCP_PROTOCOL_VERSIONS.contains(version))
                .unwrap_or(MCP_PROTOCOL_VERSION);
            Ok(mcp_result(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "zero3-codex-skills", "version": env!("CARGO_PKG_VERSION")}
                }),
            ))
        }
        "notifications/initialized" | "notifications/cancelled" => {
            Ok(StatusCode::ACCEPTED.into_response())
        }
        "ping" => Ok(mcp_result(id, json!({}))),
        "tools/list" => Ok(mcp_result(id, json!({"tools": skill_tool_catalog()}))),
        "tools/call" => skill_mcp_call_tool(runtime, id, request.get("params")).await,
        _ => Ok(mcp_error(id, -32601, "Method not found")),
    }
}

async fn skill_mcp_call_tool(
    runtime: WorkerGatewayRuntime,
    id: Value,
    params: Option<&Value>,
) -> Result<Response, ApiError> {
    let params = params.and_then(Value::as_object).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "tools/call params must be an object",
        )
    })?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "tools/call name is required"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let gateway = runtime.gateway()?;
    let submitted = gateway.submit_for(SKILL_CAPABILITY, name, arguments)?;
    let deadline = Instant::now() + StdDuration::from_secs(DEFAULT_MCP_WAIT_SECONDS);
    loop {
        let current = gateway.get(&submitted.request_id)?;
        match current.state {
            WorkerRequestState::Completed => {
                let result = current.result.unwrap_or_else(|| json!({}));
                let text = serde_json::to_string(&result).map_err(ApiError::internal)?;
                return Ok(mcp_result(
                    id,
                    json!({"content":[{"type":"text","text":text}],"structuredContent":result}),
                ));
            }
            WorkerRequestState::Failed | WorkerRequestState::Expired => {
                let error = current
                    .error
                    .unwrap_or_else(|| "Zero3 Skill RPC failed".into());
                return Ok(mcp_result(
                    id,
                    json!({"content":[{"type":"text","text":error}],"isError":true}),
                ));
            }
            WorkerRequestState::Queued | WorkerRequestState::Leased => {}
        }
        if Instant::now() >= deadline {
            return Ok(mcp_result(
                id,
                json!({"content":[{"type":"text","text":"Zero3 local Skill runtime did not answer before the gateway timeout. Retry with the same idempotencyKey."}],"isError":true}),
            ));
        }
        sleep(StdDuration::from_millis(LONG_POLL_INTERVAL_MS)).await;
    }
}

fn require_host(
    runtime: &WorkerGatewayRuntime,
    headers: &HeaderMap,
    node_id: &str,
) -> Result<(), ApiError> {
    validate_id("worker node_id", node_id)?;
    let gateway = runtime.gateway()?;
    if gateway.target_node_id != node_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "worker RPC is bound to a different Zero3 node",
        ));
    }
    let expected = runtime.host_token.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "worker gateway host authentication is not configured",
        )
    })?;
    require_bearer(headers, expected)
}

fn require_mcp(runtime: &WorkerGatewayRuntime, headers: &HeaderMap) -> Result<(), ApiError> {
    runtime.gateway()?;
    let supplied =
        bearer_token(headers).ok_or_else(|| mcp_unauthorized(runtime, "missing bearer token"))?;
    if runtime
        .mcp_token
        .as_ref()
        .is_some_and(|expected| supplied == expected.as_str())
    {
        return Ok(());
    }
    if runtime
        .oauth
        .as_ref()
        .is_some_and(|oauth| oauth.validate_access_token(supplied, "zero3.worker"))
    {
        return Ok(());
    }
    Err(mcp_unauthorized(runtime, "invalid bearer token"))
}

fn mcp_unauthorized(runtime: &WorkerGatewayRuntime, message: &str) -> ApiError {
    let mut error = ApiError::new(StatusCode::UNAUTHORIZED, message);
    if let Some(oauth) = &runtime.oauth {
        let value = format!(
            "Bearer resource_metadata=\"{}\", scope=\"zero3.worker\"",
            oauth.protected_resource_url()
        );
        if let Ok(value) = HeaderValue::from_str(&value) {
            error.headers.insert(header::WWW_AUTHENTICATE, value);
        }
    }
    error
}

fn require_skill_mcp(runtime: &WorkerGatewayRuntime, headers: &HeaderMap) -> Result<(), ApiError> {
    runtime.gateway()?;
    let expected = runtime.skill_mcp_token.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Skill MCP authentication is not configured",
        )
    })?;
    require_bearer(headers, expected)
}

fn require_bearer(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    let supplied = bearer_token(headers)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "missing bearer token"))?;
    if supplied != expected {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid bearer token",
        ));
    }
    Ok(())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn validate_mcp_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(value) = headers.get(axum::http::header::ORIGIN) else {
        return Ok(());
    };
    let origin = value
        .to_str()
        .map_err(|_| ApiError::new(StatusCode::FORBIDDEN, "invalid MCP Origin header"))?;
    let trusted = origin.strip_prefix("https://").is_some_and(|authority| {
        if authority.contains(['/', '@', '?', '#']) {
            return false;
        }
        let host = match authority.rsplit_once(':') {
            Some((host, port))
                if !host.contains(':')
                    && !port.is_empty()
                    && port.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                host
            }
            Some(_) => return false,
            None => authority,
        }
        .to_ascii_lowercase();
        host == "chatgpt.com"
            || host.ends_with(".chatgpt.com")
            || host == "openai.com"
            || host.ends_with(".openai.com")
    });
    if trusted {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "MCP Origin is not allowed",
        ))
    }
}

fn validate_mcp_protocol_header(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(value) = headers.get("mcp-protocol-version") else {
        return Ok(());
    };
    let version = value.to_str().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid MCP-Protocol-Version header",
        )
    })?;
    if SUPPORTED_MCP_PROTOCOL_VERSIONS.contains(&version) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unsupported MCP-Protocol-Version",
        ))
    }
}

fn validate_tool_for(capability: &str, tool: &str) -> Result<(), ApiError> {
    let known = match capability {
        WORKER_CAPABILITY => WORKER_TOOLS.contains(&tool),
        SKILL_CAPABILITY => SKILL_TOOLS.contains(&tool),
        REMOTE_CAPABILITY => CAPABILITY_TOOLS.contains(&tool),
        _ => false,
    };
    if known {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "unknown Zero3 capability tool",
        ))
    }
}

fn validate_active_lease(
    record: &WorkerRpcRecord,
    node_id: &str,
    lease_id: &str,
    fencing_token: u64,
) -> Result<(), ApiError> {
    if record.target_node_id != node_id || record.state != WorkerRequestState::Leased {
        return Err(ApiError::new(StatusCode::GONE, "worker RPC lease is stale"));
    }
    if record.lease_id.as_deref() != Some(lease_id) {
        return Err(ApiError::new(
            StatusCode::GONE,
            "worker RPC lease id is stale",
        ));
    }
    if record.fencing_token != fencing_token {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            "worker RPC fencing token is stale",
        ));
    }
    if record
        .lease_expires_at
        .is_none_or(|expires| expires <= Utc::now())
    {
        return Err(ApiError::new(
            StatusCode::GONE,
            "worker RPC lease has expired",
        ));
    }
    Ok(())
}

fn request_dedupe_key(capability: &str, tool: &str, arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;
    let key = object.get("idempotencyKey")?.as_str()?.trim();
    if key.is_empty() {
        return None;
    }
    let task = object.get("taskId").and_then(Value::as_str).unwrap_or("");
    let step = object.get("stepId").and_then(Value::as_str).unwrap_or("");
    let assignment = object
        .get("assignmentId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let worker = object.get("workerId").and_then(Value::as_str).unwrap_or("");
    let session = object
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let claim = object.get("claimId").and_then(Value::as_str).unwrap_or("");
    Some(format!(
        "{capability}:{tool}:{task}:{step}:{assignment}:{worker}:{session}:{claim}:{key}"
    ))
}
fn worker_tool_catalog() -> Vec<Value> {
    vec![
        tool_definition(
            "register_worker", "Register Zero3 Web Worker",
            "Register this web GPT session as a task-scoped Zero3 worker. Does not dispatch Codex, GPU, shell, or other executors.",
            json!({
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(),
                "workerType": id_schema(), "capabilities": {"type":"array","minItems":1,"maxItems":64,"items":id_schema()},
                "maxBatchSize": {"type":"integer","minimum":1,"maximum":100},
                "logicalSessionId": {"type":"string","minLength":1,"maxLength":512},
                "metadata": {"type":"object"}, "idempotencyKey": id_schema()
            }),
            &["taskId","stepId","assignmentId","workerType","capabilities","maxBatchSize","idempotencyKey"], false,
        ),
        tool_definition(
            "claim_work", "Claim Zero3 Work",
            "Claim the next V1 WorkUnits or Workflow Worker v2 StageRuns. Supply bindingTicket for v2; the old V1 identity fields remain compatible.",
            json!({
                "bindingTicket": {"type":"string","minLength":1,"maxLength":16384},
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(),
                "workerId": id_schema(), "sessionId": id_schema(),
                "maxItems": {"type":"integer","minimum":1,"maximum":100},
                "leaseSeconds": {"type":"integer","minimum":1,"maximum":86400},
                "idempotencyKey": id_schema()
            }),
            &["idempotencyKey"], false,
        ),        tool_definition(
            "report_progress", "Report Zero3 Work Progress",
            "Report progress and renew a V1 Claim or a generation-fenced Workflow Worker v2 Claim. Supply bindingTicket for v2.",
            json!({
                "bindingTicket": {"type":"string","minLength":1,"maxLength":16384},
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(),
                "workerId": id_schema(), "sessionId": id_schema(), "claimId": id_schema(),
                "progress": {"type":"number","minimum":0,"maximum":1},
                "currentActivity": {"type":"string","maxLength":2048},
                "runningUnitIds": {"type":"array","maxItems":100,"items":id_schema()},
                "leaseSeconds": {"type":"integer","minimum":1,"maximum":86400},
                "idempotencyKey": id_schema()
            }),
            &["claimId","progress","idempotencyKey"], false,
        ),
        tool_definition(
            "complete_and_claim_next", "Complete Zero3 Batch And Claim Next",
            "Atomically record the active Claim outcome and claim the next batch in the local Zero3 Worker Runtime.",
            json!({
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(), "workerId": id_schema(),
                "sessionId": id_schema(), "claimId": id_schema(),
                "completedUnits": {"type":"array","maxItems":100,"items":completed_unit_schema()},
                "failedUnits": {"type":"array","maxItems":100,"items":failed_unit_schema()},
                "maxItems": {"type":"integer","minimum":1,"maximum":100},
                "leaseSeconds": {"type":"integer","minimum":60,"maximum":86400}, "idempotencyKey": id_schema()
            }),
            &["taskId","stepId","assignmentId","workerId","sessionId","claimId","completedUnits","idempotencyKey"], false,
        ),        tool_definition(
            "report_failure", "Report Zero3 Claim Failure",
            "Record a Claim failure and safely requeue retryable units without declaring the parent Step completed.",
            json!({
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(),
                "workerId": id_schema(), "sessionId": id_schema(), "claimId": id_schema(),
                "reason": {"type":"string","minLength":1,"maxLength":4096}, "retryable": {"type":"boolean"},
                "idempotencyKey": id_schema()
            }),
            &["taskId","stepId","assignmentId","workerId","sessionId","claimId","reason","idempotencyKey"], false,
        ),
        tool_definition(
            "get_task_context", "Get Zero3 Worker Context",
            "Recover authoritative local Zero3 worker state after web GPT context loss or session interruption.",
            json!({
                "taskId": id_schema(), "stepId": id_schema(), "assignmentId": id_schema(),
                "workerId": id_schema(), "sessionId": id_schema()
            }),
            &["taskId","stepId","assignmentId","workerId","sessionId"], true,
        ),
        tool_definition(
            "session_start", "Start Zero3 Agent Session",
            "Start or resume a shared organizational agent session and bind it to an authoritative Zero3 Task.",
            json!({
                "agentType": {"type":"string","enum":["web_gpt","codex","claude","hermes","zero3","antigravity","other"]},
                "agentId": id_schema(), "sessionId": id_schema(), "projectId": id_schema(), "taskId": id_schema(), "idempotencyKey": id_schema()
            }),
            &["agentType","sessionId","projectId","idempotencyKey"], false,
        ),
        tool_definition(
            "context_resolve", "Resolve Zero3 Shared Context",
            "Resolve filtered Task State, Shared Memory, Decisions, Artifacts, Worklog, Handoff and next actions for this session.",
            json!({"sessionId": id_schema()}), &["sessionId"], true,
        ),
        tool_definition(
            "task_claim", "Claim Zero3 Task",
            "Bind the current agent session to available GPT_WEB work in the authoritative Task Runtime with duplicate-execution protection.",
            json!({
                "sessionId": id_schema(), "taskId": id_schema(),
                "conversationId": {"type":"string","maxLength":512}, "conversationUrl": {"type":"string","maxLength":4096},
                "idempotencyKey": id_schema()
            }), &["sessionId","idempotencyKey"], false,
        ),
        tool_definition(
            "event_record", "Record Zero3 Agent Event",
            "Record an important decision, progress, warning, error, discovery, user instruction or dependency into Worklog and Shared Memory policy hooks.",
            json!({
                "sessionId": id_schema(),
                "eventType": {"type":"string","enum":["decision","progress","warning","error","discovery","user_instruction","dependency"]},
                "content": {"anyOf":[{"type":"string","minLength":1,"maxLength":4096},{"type":"object"}]},
                "importance": {"type":"string","enum":["low","normal","high","critical"]},
                "scope": {"type":"string","enum":["project","task"]}, "progress": {"type":"number","minimum":0,"maximum":1},
                "idempotencyKey": id_schema()
            }), &["sessionId","eventType","content","idempotencyKey"], false,
        ),
        tool_definition(
            "artifact_register", "Register Zero3 Artifact",
            "Register structured artifact metadata produced by this agent. Google Drive credentials never pass through this tool.",
            json!({
                "sessionId": id_schema(), "artifactId": id_schema(), "name": {"type":"string","minLength":1,"maxLength":1024},
                "kind": id_schema(), "type": id_schema(), "mimeType": {"type":"string","maxLength":256},
                "storage": {"type":"object","properties":{
                    "provider":{"type":"string","enum":["GOOGLE_DRIVE","google_drive","LOCAL","local","REMOTE_COMPUTE","remote_compute","URL","url"]},
                    "fileId":{"type":"string","maxLength":2048},"path":{"type":"string","maxLength":8192},
                    "uri":{"type":"string","maxLength":8192},"webUrl":{"type":"string","maxLength":8192}
                },"required":["provider"],"additionalProperties":false},
                "description":{"type":"string","maxLength":8192},"version":{"type":"integer","minimum":1},
                "status":{"type":"string","enum":["draft","produced","approved","rejected","superseded"]},
                "sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"},"sizeBytes":{"type":"integer","minimum":0},
                "idempotencyKey": id_schema()
            }), &["sessionId","name","storage","idempotencyKey"], false,
        ),
        tool_definition(
            "task_complete", "Complete Zero3 Agent Work",
            "Submit completion through the authoritative Task Runtime while atomically producing Worklog, Memory and Handoff records; Completion Gate remains authoritative.",
            json!({
                "sessionId": id_schema(), "summary":{"type":"string","maxLength":64000},
                "artifacts":{"type":"array","maxItems":100,"items":{"type":"object"}},
                "decisions":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "warnings":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "recommendedNextActions":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "idempotencyKey": id_schema()
            }), &["sessionId","idempotencyKey"], false,
        ),
        tool_definition(
            "memory_commit", "Commit Zero3 Shared Memory",
            "Submit semantic summary candidates to Zero3 Memory routing. Runtime persists a compensation outbox before remote publication.",
            json!({
                "sessionId": id_schema(), "summary":{"type":"string","maxLength":64000},
                "projectMemory":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "decisions":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "discoveries":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "warnings":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "recommendedNextActions":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"string"},{"type":"object"}]}},
                "idempotencyKey": id_schema()
            }), &["sessionId","idempotencyKey"], false,
        ),
        tool_definition(
            "handoff_create", "Create Zero3 Agent Handoff",
            "Create a structured task handoff so another agent session can continue without reading prior chat history.",
            json!({
                "sessionId": id_schema(), "summary":{"type":"string","maxLength":64000},
                "completedItems":{"type":"array","maxItems":1000},"remainingItems":{"type":"array","maxItems":1000},
                "decisions":{"type":"array","maxItems":100},"warnings":{"type":"array","maxItems":100},
                "nextAction":{"type":"string","maxLength":4096},"idempotencyKey":id_schema()
            }), &["sessionId","idempotencyKey"], false,
        ),
        tool_definition(
            "task_bootstrap", "Bootstrap Zero3 Agent Task",
            "Start or resume the authoritative Web GPT session, claim available GPT_WEB work and resolve filtered shared context in one retry-safe round trip.",
            json!({
                "agentType":{"type":"string","enum":["web_gpt"]}, "agentId":id_schema(),
                "sessionId":id_schema(), "projectId":id_schema(), "taskId":id_schema(),
                "conversationId":{"type":"string","maxLength":512}, "conversationUrl":{"type":"string","maxLength":4096},
                "idempotencyKey":id_schema()
            }), &["agentType","sessionId","projectId","idempotencyKey"], false,
        ),
        tool_definition(
            "dispatch_codex_task", "Dispatch Bounded Codex Task",
            "Dispatch one typed high-level development task through the existing Zero3 Remote Host control plane. No shell command, filesystem primitive, token, or destination node is exposed.",
            json!({
                "sessionId":id_schema(), "workspace":{"type":"string","minLength":1,"maxLength":4096},
                "objective":{"type":"string","minLength":1,"maxLength":64000}, "baseRef":{"type":"string","maxLength":256},
                "constraints":{"type":"array","maxItems":64,"items":{"type":"string","minLength":1,"maxLength":4096}},
                "acceptanceCriteria":{"type":"array","maxItems":64,"items":{"type":"string","minLength":1,"maxLength":4096}},
                "permissionProfile":{"type":"string","enum":["read_only","standard","elevated"]},
                "maxTurns":{"type":"integer","minimum":1,"maximum":8}, "timeoutSeconds":{"type":"integer","minimum":30,"maximum":28800},
                "requireCleanWorktree":{"type":"boolean"}, "requireCleanWorktreeOnSuccess":{"type":"boolean"},
                "requireRemoteSyncOnSuccess":{"type":"boolean"}, "idempotencyKey":id_schema()
            }), &["sessionId","workspace","objective","idempotencyKey"], false,
        ),
        tool_definition(
            "verify_commit", "Verify Commit And Push",
            "Run only allow-listed static checks, then stage only declared task-owned paths, create one scoped Git commit and non-force push the current branch. Fails closed on unrelated staged changes or unsafe repository state.",
            json!({
                "sessionId":id_schema(), "workspace":{"type":"string","minLength":1,"maxLength":4096},
                "paths":{"type":"array","minItems":1,"maxItems":256,"items":{"type":"string","minLength":1,"maxLength":4096}},
                "checks":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","enum":["git_diff_check","cargo_fmt_check","cargo_check_web","desktop_typecheck"]}},
                "commitMessage":{"type":"string","minLength":1,"maxLength":512}, "idempotencyKey":id_schema()
            }), &["sessionId","workspace","paths","checks","commitMessage","idempotencyKey"], false,
        ),
        tool_definition(
            "bootstrap_worker", "Bootstrap Zero3 Workflow Worker",
            "Validate a generation-fenced Worker Binding Ticket and restore the long-lived Workflow worker slot/session context.",
            json!({"bindingTicket":{"type":"string","minLength":1,"maxLength":16384}}),
            &["bindingTicket"], false,
        ),
        tool_definition(
            "commit_and_claim_next", "Commit Zero3 Workflow Work And Claim Next",
            "Atomically commit structured Artifacts for the active Workflow Claim, complete StageRuns, release dependent stages and claim the next available work.",
            json!({
                "bindingTicket":{"type":"string","minLength":1,"maxLength":16384},"claimId":id_schema(),
                "artifacts":{"type":"array","maxItems":1000,"items":{"type":"object"}},
                "maxItems":{"type":"integer","minimum":1,"maximum":100},
                "leaseSeconds":{"type":"integer","minimum":1,"maximum":86400},"idempotencyKey":id_schema()
            }), &["bindingTicket","claimId","artifacts","idempotencyKey"], false,
        ),
        tool_definition(
            "report_blocked", "Report Zero3 Workflow Claim Blocked",
            "End the active Workflow Claim with retryable, human-waiting or terminal blocked semantics decided by Zero3.",
            json!({
                "bindingTicket":{"type":"string","minLength":1,"maxLength":16384},"claimId":id_schema(),
                "disposition":{"type":"string","enum":["BLOCKED_RETRYABLE","WAITING_HUMAN","BLOCKED_TERMINAL"]},
                "reason":{"type":"string","minLength":1,"maxLength":4096},"idempotencyKey":id_schema()
            }), &["bindingTicket","claimId","disposition","reason","idempotencyKey"], false,
        ),
        tool_definition(
            "recover_worker", "Recover Zero3 Workflow Worker",
            "Recover authoritative WorkerSlot, Physical Session, active Claim and ready-work state after page refresh or context loss.",
            json!({"bindingTicket":{"type":"string","minLength":1,"maxLength":16384}}),
            &["bindingTicket"], false,
        ),
    ]
}

fn capability_tool_catalog() -> Vec<Value> {
    vec![
        tool_definition(
            "list_capabilities", "List Zero3 Local Capabilities",
            "List capabilities currently registered by the authoritative local Zero3 Pilot. The plugin only transports this request; execution authority remains local.",
            json!({"category":{"type":"string","minLength":1,"maxLength":128}}), &[], true,
        ),
        tool_definition(
            "describe_capability", "Describe Zero3 Local Capability",
            "Return the local Zero3 definition, schemas, availability and execution metadata for one registered capability.",
            json!({"capability":{"type":"string","minLength":1,"maxLength":128}}), &["capability"], true,
        ),
        tool_definition(
            "invoke_capability", "Invoke Zero3 Local Capability",
            "Ask local Zero3 Pilot to authorize and invoke one registered capability. Local Policy remains authoritative; long-running work is represented by an operationId.",
            json!({
                "capability":{"type":"string","minLength":1,"maxLength":128},
                "input":{"type":"object"},
                "context":{"type":"object","properties":{
                    "projectId":id_schema(),"taskId":id_schema(),"sessionId":id_schema()
                },"additionalProperties":false},
                "idempotencyKey":id_schema()
            }), &["capability","idempotencyKey"], false,
        ),
        tool_definition(
            "get_operation", "Get Zero3 Capability Operation",
            "Read authoritative local execution state/result for a previously invoked Zero3 capability operation.",
            json!({"operationId":id_schema()}), &["operationId"], true,
        ),
        tool_definition(
            "cancel_operation", "Cancel Zero3 Capability Operation",
            "Request cancellation of a cancellable local Zero3 capability operation. Cancellation is enforced by the local runtime.",
            json!({"operationId":id_schema(),"idempotencyKey":id_schema()}), &["operationId"], false,
        ),
    ]
}

fn mcp_tool_catalog() -> Vec<Value> {
    let mut tools = worker_tool_catalog();
    tools.extend(capability_tool_catalog());
    tools
}

fn skill_tool_catalog() -> Vec<Value> {
    vec![
        tool_definition(
            "list_skills", "List Codex Native Skills",
            "List Skills discovered by the local Zero3 Codex app-server. This reads the same Codex Skill source of truth used by local Codex sessions.",
            json!({
                "cwd":{"type":"string","maxLength":4096},
                "forceReload":{"type":"boolean"},
                "idempotencyKey":id_schema()
            }), &[], true,
        ),
        tool_definition(
            "search_skills", "Search Codex Native Skills",
            "Search local Codex Skill metadata by name, description or path without copying SKILL.md into the web session.",
            json!({
                "query":{"type":"string","minLength":1,"maxLength":1024},
                "cwd":{"type":"string","maxLength":4096},
                "limit":{"type":"integer","minimum":1,"maximum":100},
                "forceReload":{"type":"boolean"},
                "idempotencyKey":id_schema()
            }), &["query"], true,
        ),
        tool_definition(
            "get_skill", "Read Codex Native Skill",
            "Read one bounded SKILL.md from the local Codex Skill catalog for this web GPT task. The local absolute path is never returned.",
            json!({
                "selector":{"type":"string","minLength":1,"maxLength":4096},
                "cwd":{"type":"string","maxLength":4096},
                "forceReload":{"type":"boolean"},
                "idempotencyKey":id_schema()
            }), &["selector"], true,
        ),
        tool_definition(
            "invoke_skill", "Invoke Codex Native Skill",
            "Invoke one installed Codex Skill through the local Codex Agent Kernel. The Skill stays on the Zero3 host; only the structured result returns to this web GPT session.",
            json!({
                "selector":{"type":"string","minLength":1,"maxLength":4096},
                "prompt":{"type":"string","minLength":1,"maxLength":100000},
                "cwd":{"type":"string","maxLength":4096},
                "idempotencyKey":id_schema()
            }), &["selector","prompt","cwd","idempotencyKey"], false,
        ),
    ]
}

fn id_schema() -> Value {
    json!({"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9._:-]+$"})
}

fn completed_unit_schema() -> Value {
    json!({
        "anyOf": [
            id_schema(),
            {
                "type": "object",
                "properties": {
                    "unitId": id_schema(),
                    "artifactRefs": {"type":"array","maxItems":100,"items":{"type":"string","minLength":1,"maxLength":2048}}
                },
                "required": ["unitId"],
                "additionalProperties": false
            }
        ]
    })
}

fn failed_unit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "unitId": id_schema(),
            "reason": {"type":"string","minLength":1,"maxLength":4096},
            "retryable": {"type":"boolean"}
        },
        "required": ["unitId", "reason"],
        "additionalProperties": false
    })
}
fn tool_definition(
    name: &str,
    title: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        },
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false
        }
    })
}

fn mcp_result(id: Value, result: Value) -> Response {
    (
        StatusCode::OK,
        Json(json!({"jsonrpc":"2.0","id":id,"result":result})),
    )
        .into_response()
}

fn mcp_error(id: Value, code: i64, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})),
    )
        .into_response()
}
fn resolve_oauth_issuer(
    runtime_enabled: bool,
    runtime_issuer: Option<&str>,
    built_issuer: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let runtime = runtime_issuer
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let built = built_issuer
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(issuer) = runtime.or(built) {
        return Ok(Some(issuer.to_string()));
    }
    if runtime_enabled {
        anyhow::bail!(
            "ZERO3_WORKER_OAUTH_ISSUER is required when Worker OAuth is enabled unless the release has ZERO3_WORKER_OAUTH_ISSUER_BUILD"
        );
    }
    Ok(None)
}

fn parse_bool(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn required_env(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).unwrap_or_default().trim().to_string();
    if value.is_empty() {
        anyhow::bail!("{name} is required when Zero3 Worker Gateway is enabled");
    }
    Ok(value)
}

fn optional_secret_file(name: &str) -> anyhow::Result<Option<String>> {
    let Some(path) = std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    Ok(Some(read_secret_file(path.trim())?))
}

fn read_secret_file(path: &str) -> anyhow::Result<String> {
    let secret = fs::read_to_string(path)?.trim().to_string();
    if secret.len() < 32 {
        anyhow::bail!("worker gateway secret file must contain at least 32 characters: {path}");
    }
    Ok(secret)
}

fn validate_id(label: &str, value: &str) -> Result<(), ApiError> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("{label} is invalid"),
        ))
    }
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
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("state path has no parent"))?;
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

    #[test]
    fn queue_lease_completion_is_durable_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = WorkerGateway::open(dir.path().to_path_buf(), "node-worker".into()).unwrap();
        let args = json!({"taskId":"task-1","stepId":"step-1","assignmentId":"asg-1","idempotencyKey":"idem-1"});
        let first = gateway.submit("claim_work", args.clone()).unwrap();
        let replay = gateway.submit("claim_work", args).unwrap();
        assert_eq!(first.request_id, replay.request_id);
        let lease = gateway.try_lease("node-worker").unwrap().unwrap();
        gateway
            .complete(
                &first.request_id,
                "node-worker",
                &lease.lease_id,
                lease.fencing_token,
                json!({"ok":true}),
            )
            .unwrap();
        drop(gateway);
        let reopened = WorkerGateway::open(dir.path().to_path_buf(), "node-worker".into()).unwrap();
        let stored = reopened.get(&first.request_id).unwrap();
        assert_eq!(stored.state, WorkerRequestState::Completed);
        assert_eq!(stored.result, Some(json!({"ok":true})));
    }
    #[test]
    fn idempotency_scope_does_not_collide_between_parallel_workers() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = WorkerGateway::open(dir.path().to_path_buf(), "node-worker".into()).unwrap();
        let first = gateway
            .submit(
                "claim_work",
                json!({
                    "taskId":"task-1","stepId":"step-1","assignmentId":"asg-1",
                    "workerId":"worker-a","sessionId":"session-a","idempotencyKey":"claim-1"
                }),
            )
            .unwrap();
        let second = gateway
            .submit(
                "claim_work",
                json!({
                    "taskId":"task-1","stepId":"step-1","assignmentId":"asg-1",
                    "workerId":"worker-b","sessionId":"session-b","idempotencyKey":"claim-1"
                }),
            )
            .unwrap();
        assert_ne!(first.request_id, second.request_id);
    }

    #[test]
    fn tool_catalog_is_narrow_and_matches_worker_protocol() {
        let catalog = worker_tool_catalog();
        let names: Vec<&str> = catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, WORKER_TOOLS);
        let serialized = serde_json::to_string(&catalog).unwrap();
        assert!(serialized.contains("dispatch_codex_task"));
        assert!(serialized.contains("verify_commit"));
        assert!(serialized.contains("task_bootstrap"));
        assert!(!serialized.contains("run_gpu"));
        assert!(!serialized.contains("workflow_admin"));
    }

    #[test]
    fn skill_catalog_is_separate_from_worker_protocol() {
        let catalog = skill_tool_catalog();
        let names: Vec<&str> = catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, SKILL_TOOLS);
        let worker = serde_json::to_string(&worker_tool_catalog()).unwrap();
        assert!(!worker.contains("invoke_skill"));
    }

    #[test]
    fn skill_rpc_gets_a_long_execution_lease_without_changing_worker_leases() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = WorkerGateway::open(dir.path().to_path_buf(), "node-1".into()).unwrap();
        let worker = gateway.submit("get_task_context", json!({"taskId":"t","stepId":"s","assignmentId":"a","workerId":"w","sessionId":"x"})).unwrap();
        let skill = gateway.submit_for(SKILL_CAPABILITY, "invoke_skill", json!({"selector":"demo","prompt":"run","cwd":"/workspace","idempotencyKey":"skill-1"})).unwrap();
        assert!(
            skill.expires_at - skill.created_at >= Duration::seconds(SKILL_REQUEST_TTL_SECONDS)
        );
        assert!(
            worker.expires_at - worker.created_at <= Duration::seconds(DEFAULT_REQUEST_TTL_SECONDS)
        );
        let lease = gateway
            .try_lease_for("node-1", &[SKILL_CAPABILITY.to_string()])
            .unwrap()
            .unwrap();
        let expiry = DateTime::parse_from_rfc3339(&lease.lease_expires_at)
            .unwrap()
            .with_timezone(&Utc);
        assert!(expiry - Utc::now() > Duration::minutes(10));
    }

    #[test]
    fn verify_commit_is_deduplicated_and_gets_a_long_execution_lease() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = WorkerGateway::open(dir.path().to_path_buf(), "node-1".into()).unwrap();
        let args = json!({
            "sessionId":"session-1", "workspace":"C:/repo", "paths":["apps/web"],
            "checks":["git_diff_check"], "commitMessage":"test", "idempotencyKey":"verify-1"
        });
        let first = gateway.submit("verify_commit", args.clone()).unwrap();
        let replay = gateway.submit("verify_commit", args).unwrap();
        assert_eq!(first.request_id, replay.request_id);
        assert!(
            first.expires_at - first.created_at >= Duration::seconds(SKILL_REQUEST_TTL_SECONDS)
        );
        let lease = gateway.try_lease("node-1").unwrap().unwrap();
        assert_eq!(lease.tool, "verify_commit");
        let expiry = DateTime::parse_from_rfc3339(&lease.lease_expires_at)
            .unwrap()
            .with_timezone(&Utc);
        assert!(expiry - Utc::now() > Duration::minutes(10));
    }

    #[test]
    fn capability_catalog_is_separate_and_routes_on_its_own_protocol() {
        let catalog = capability_tool_catalog();
        let names: Vec<&str> = catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, CAPABILITY_TOOLS);
        let all = mcp_tool_catalog();
        assert_eq!(all.len(), WORKER_TOOLS.len() + CAPABILITY_TOOLS.len());

        let dir = tempfile::tempdir().unwrap();
        let gateway = WorkerGateway::open(dir.path().to_path_buf(), "node-1".into()).unwrap();
        let request = gateway
            .submit_for(
                REMOTE_CAPABILITY,
                "invoke_capability",
                json!({"capability":"system.status","idempotencyKey":"cap-1"}),
            )
            .unwrap();
        assert_eq!(request.capability, REMOTE_CAPABILITY);
        let lease = gateway
            .try_lease_for("node-1", &[REMOTE_CAPABILITY.to_string()])
            .unwrap()
            .unwrap();
        assert_eq!(lease.capability, REMOTE_CAPABILITY);
        assert_eq!(lease.tool, "invoke_capability");
    }

    #[test]
    fn capability_protocol_rejects_worker_tools_and_worker_protocol_rejects_capability_tools() {
        assert!(validate_tool_for(REMOTE_CAPABILITY, "system_status_missing").is_err());
        assert!(validate_tool_for(REMOTE_CAPABILITY, "claim_work").is_err());
        assert!(validate_tool_for(WORKER_CAPABILITY, "invoke_capability").is_err());
        assert!(validate_tool_for(REMOTE_CAPABILITY, "invoke_capability").is_ok());
    }

    #[test]
    fn stale_fencing_is_rejected_after_lease_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let mut gateway =
            WorkerGateway::open(dir.path().to_path_buf(), "node-worker".into()).unwrap();
        gateway.lease_ttl = Duration::milliseconds(5);
        let record = gateway
            .submit("get_task_context", json!({"taskId":"task-1"}))
            .unwrap();
        let first = gateway.try_lease("node-worker").unwrap().unwrap();
        std::thread::sleep(StdDuration::from_millis(10));
        gateway.lease_ttl = Duration::seconds(DEFAULT_LEASE_TTL_SECONDS);
        let second = gateway.try_lease("node-worker").unwrap().unwrap();
        assert!(second.fencing_token > first.fencing_token);
        let error = gateway
            .complete(
                &record.request_id,
                "node-worker",
                &first.lease_id,
                first.fencing_token,
                json!({}),
            )
            .unwrap_err();
        assert!(matches!(
            error.status,
            StatusCode::GONE | StatusCode::PRECONDITION_FAILED
        ));
        gateway
            .complete(
                &record.request_id,
                "node-worker",
                &second.lease_id,
                second.fencing_token,
                json!({"ok":true}),
            )
            .unwrap();
    }
    #[test]
    fn mcp_origin_and_protocol_headers_fail_closed_when_present_and_invalid() {
        let mut trusted = HeaderMap::new();
        trusted.insert(
            axum::http::header::ORIGIN,
            "https://chatgpt.com".parse().unwrap(),
        );
        trusted.insert("mcp-protocol-version", "2025-11-25".parse().unwrap());
        assert!(validate_mcp_origin(&trusted).is_ok());
        assert!(validate_mcp_protocol_header(&trusted).is_ok());

        let mut evil = HeaderMap::new();
        evil.insert(
            axum::http::header::ORIGIN,
            "https://chatgpt.com.evil.invalid".parse().unwrap(),
        );
        assert_eq!(
            validate_mcp_origin(&evil).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        let mut userinfo = HeaderMap::new();
        userinfo.insert(
            axum::http::header::ORIGIN,
            "https://chatgpt.com:443@evil.invalid".parse().unwrap(),
        );
        assert_eq!(
            validate_mcp_origin(&userinfo).unwrap_err().status,
            StatusCode::FORBIDDEN
        );

        let mut unsupported = HeaderMap::new();
        unsupported.insert("mcp-protocol-version", "2099-01-01".parse().unwrap());
        assert_eq!(
            validate_mcp_protocol_header(&unsupported)
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn oauth_enabled_mcp_challenge_advertises_protected_resource_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = Arc::new(
            WorkerGateway::open(dir.path().join("gateway"), "node-worker".into()).unwrap(),
        );
        let oauth = Arc::new(
            OAuthServer::open(
                dir.path().join("oauth"),
                "https://pilot.03.336r.com".into(),
                "test-owner-secret-abcdefghijklmnopqrstuvwxyz",
            )
            .unwrap(),
        );
        let runtime = WorkerGatewayRuntime {
            gateway: Some(gateway),
            host_token: None,
            mcp_token: None,
            skill_mcp_token: None,
            oauth: Some(oauth),
        };
        let error = require_mcp(&runtime, &HeaderMap::new()).unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        let challenge = error
            .headers
            .get(header::WWW_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(challenge.contains("/.well-known/oauth-protected-resource/mcp"));
        assert!(challenge.contains("zero3.worker"));
    }

    #[test]
    fn oauth_issuer_resolution_supports_immutable_host_specific_releases() {
        assert_eq!(resolve_oauth_issuer(false, None, None).unwrap(), None);
        assert_eq!(
            resolve_oauth_issuer(false, None, Some("https://built.example"))
                .unwrap()
                .as_deref(),
            Some("https://built.example")
        );
        assert_eq!(
            resolve_oauth_issuer(
                true,
                Some("https://runtime.example"),
                Some("https://built.example")
            )
            .unwrap()
            .as_deref(),
            Some("https://runtime.example")
        );
        assert!(resolve_oauth_issuer(true, None, None).is_err());
    }

    #[test]
    fn static_worker_mcp_token_remains_compatible_when_oauth_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = WorkerGatewayRuntime {
            gateway: Some(Arc::new(
                WorkerGateway::open(dir.path().to_path_buf(), "node-worker".into()).unwrap(),
            )),
            host_token: None,
            mcp_token: Some(Arc::new("test".into())),
            skill_mcp_token: None,
            oauth: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer test".parse().unwrap());
        assert!(require_mcp(&runtime, &headers).is_ok());
    }
}
