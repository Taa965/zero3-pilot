//! Zero3 Pilot local-first runtime node.
//!
//! The node binds to loopback only and is the single local control plane for
//! desktop UI, providers, subagents, persistent jobs, schedules, and memory.
//! Side-effecting browser/computer/subagent requests are routed through the
//! shared `zero3-core` policy seam before execution.

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::sleep;
use uuid::Uuid;
use zero3_core::job::JobStatus;
use zero3_core::permission::{
    ActionRequest, Decision, DefaultPolicy, PermissionLevel, PolicyEngine,
};
use zero3_core::subagent::SubagentTask;
use zero3_memory::{MemoryClass, MemoryRecord, MemoryScope, MemoryStore, SqliteMemoryStore};
use zero3_providers::browser::{BrowserAction, BrowserProvider, CdpBrowserProvider};
use zero3_providers::computer::{ComputerAction, ComputerProvider};
use zero3_providers::open_computer_use::OpenComputerUseAdapter;
use zero3_providers::Provider;
use zero3_scheduler::persistent::{PersistentScheduler, ScheduleSpec, ScheduledTask};
use zero3_scheduler::{JobManager, JobRecord, RecoveryMode};
use zero3_store::EventStore;
use zero3_subagents::workers::{ClaudeWorker, CliWorkerConfig, CodexWorker, HermesWorker};
use zero3_subagents::SubagentRegistry;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 8790;
const UI_HTML: &str = include_str!("../static/index.html");

#[derive(Clone)]
struct AppState {
    jobs: Arc<JobManager>,
    scheduler: Arc<PersistentScheduler>,
    memory: Arc<SqliteMemoryStore>,
    agents: Arc<SubagentRegistry>,
    browser: Arc<CdpBrowserProvider>,
    computer: Arc<OpenComputerUseAdapter>,
    data_dir: PathBuf,
    recovery_tail: Option<String>,
    allowed_origins: Vec<String>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn approval_required(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PRECONDITION_REQUIRED,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalContext {
    #[serde(default = "default_permission")]
    granted_level: PermissionLevel,
    #[serde(default)]
    approved: bool,
}

fn default_permission() -> PermissionLevel {
    PermissionLevel::Standard
}

impl Default for ApprovalContext {
    fn default() -> Self {
        Self {
            granted_level: default_permission(),
            approved: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentRunRequest {
    backend: String,
    goal: String,
    #[serde(default)]
    context: Value,
    #[serde(flatten)]
    approval: ApprovalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserRunRequest {
    action: BrowserAction,
    #[serde(flatten)]
    approval: ApprovalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ComputerRunRequest {
    action: ComputerAction,
    #[serde(flatten)]
    approval: ApprovalContext,
}

#[derive(Debug, Deserialize)]
struct ScheduleCreateRequest {
    job_kind: String,
    payload: Value,
    schedule: ScheduleSpec,
    first_run_at: DateTime<Utc>,
    #[serde(flatten)]
    approval: ApprovalContext,
}

#[derive(Debug, Deserialize)]
struct ScheduleEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct MemoryPutRequest {
    key: String,
    value: Value,
    class: MemoryClass,
    #[serde(default = "global_scope")]
    scope: MemoryScope,
    #[serde(default = "ui_source")]
    source: String,
    #[serde(default)]
    approved: bool,
}

fn global_scope() -> MemoryScope {
    MemoryScope::Global
}

fn ui_source() -> String {
    "desktop-ui".into()
}

#[derive(Debug, Deserialize)]
struct MemoryQuery {
    query: Option<String>,
    scope: Option<String>,
    scope_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct AcceptedJob {
    job_id: Uuid,
}

fn action_gate(
    granted: PermissionLevel,
    approved: bool,
    actor: &str,
    action: &str,
    required_level: PermissionLevel,
    reversible: bool,
) -> Result<(), ApiError> {
    let request = ActionRequest {
        actor: actor.into(),
        action: action.into(),
        required_level,
        reversible,
    };
    match DefaultPolicy.evaluate(granted, &request) {
        Decision::Allow => Ok(()),
        Decision::Deny => Err(ApiError::forbidden(format!(
            "policy denied {actor}:{action} at permission {granted:?}"
        ))),
        Decision::RequireApproval if approved => Ok(()),
        Decision::RequireApproval => Err(ApiError::approval_required(format!(
            "{actor}:{action} requires explicit approval"
        ))),
    }
}

fn enforce_origin(headers: &HeaderMap, state: &AppState) -> Result<(), ApiError> {
    let Some(origin) = headers.get("origin") else {
        // Native/CLI local clients normally send no Origin header. The node is
        // loopback-only, so browser-origin validation is specifically for
        // blocking drive-by web pages from issuing localhost mutations.
        return Ok(());
    };
    let origin = origin
        .to_str()
        .map_err(|_| ApiError::forbidden("invalid Origin header"))?;
    if state
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "cross-origin mutation rejected: {origin}"
        )))
    }
}

fn browser_policy(action: &BrowserAction) -> (&'static str, PermissionLevel, bool) {
    match action {
        BrowserAction::Click { .. }
        | BrowserAction::Type { .. }
        | BrowserAction::PressKey { .. }
        | BrowserAction::Evaluate { .. } => ("browser.write", PermissionLevel::Elevated, true),
        BrowserAction::Launch { .. }
        | BrowserAction::Connect { .. }
        | BrowserAction::Open { .. }
        | BrowserAction::Navigate { .. }
        | BrowserAction::Close => ("browser.session", PermissionLevel::Standard, true),
        _ => ("browser.read", PermissionLevel::ReadOnly, true),
    }
}

fn computer_policy(action: &ComputerAction) -> (&'static str, PermissionLevel, bool) {
    match action {
        ComputerAction::ListApps | ComputerAction::Screenshot { .. } => {
            ("computer.read", PermissionLevel::ReadOnly, true)
        }
        ComputerAction::Click { .. }
        | ComputerAction::Type { .. }
        | ComputerAction::KeyPress { .. } => ("computer.write", PermissionLevel::Elevated, true),
    }
}

fn scope_from_query(query: &MemoryQuery) -> Result<Option<MemoryScope>, ApiError> {
    match query.scope.as_deref() {
        None | Some("") => Ok(None),
        Some("global") => Ok(Some(MemoryScope::Global)),
        Some("session") => Ok(Some(MemoryScope::Session {
            session_id: query
                .scope_id
                .clone()
                .ok_or_else(|| ApiError::bad_request("session scope requires scope_id"))?,
        })),
        Some("thread") => Ok(Some(MemoryScope::Thread {
            thread_id: query
                .scope_id
                .clone()
                .ok_or_else(|| ApiError::bad_request("thread scope requires scope_id"))?,
        })),
        Some(other) => Err(ApiError::bad_request(format!(
            "unknown memory scope {other:?}"
        ))),
    }
}

fn unwrap_scheduled_payload(payload: &Value) -> Value {
    if payload.get("schedule_id").is_some() && payload.get("scheduled_for").is_some() {
        payload.get("payload").cloned().unwrap_or(Value::Null)
    } else {
        payload.clone()
    }
}

async fn execute_job(state: Arc<AppState>, job_id: Uuid) {
    let Some(record) = state.jobs.get(job_id) else {
        return;
    };
    if record.status != JobStatus::Queued {
        return;
    }
    if state.jobs.start(job_id).is_err() {
        return;
    }

    let payload = unwrap_scheduled_payload(&record.payload);
    let result: anyhow::Result<Value> = match record.kind.as_str() {
        "subagent" => {
            async {
                let request: AgentRunRequest = serde_json::from_value(payload)?;
                action_gate(
                    request.approval.granted_level,
                    request.approval.approved,
                    "subagent",
                    "dispatch",
                    PermissionLevel::Elevated,
                    true,
                )
                .map_err(|error| anyhow::anyhow!(error.message))?;
                let result = state
                    .agents
                    .dispatch(
                        &request.backend,
                        SubagentTask {
                            goal: request.goal,
                            context: request.context,
                        },
                    )
                    .await?;
                Ok(serde_json::to_value(result)?)
            }
            .await
        }
        "browser" => {
            async {
                let request: BrowserRunRequest = serde_json::from_value(payload)?;
                let (action, level, reversible) = browser_policy(&request.action);
                action_gate(
                    request.approval.granted_level,
                    request.approval.approved,
                    "browser",
                    action,
                    level,
                    reversible,
                )
                .map_err(|error| anyhow::anyhow!(error.message))?;
                Ok(serde_json::to_value(
                    state.browser.execute(request.action).await?,
                )?)
            }
            .await
        }
        "computer" => {
            async {
                let request: ComputerRunRequest = serde_json::from_value(payload)?;
                let (action, level, reversible) = computer_policy(&request.action);
                action_gate(
                    request.approval.granted_level,
                    request.approval.approved,
                    "computer",
                    action,
                    level,
                    reversible,
                )
                .map_err(|error| anyhow::anyhow!(error.message))?;
                Ok(serde_json::to_value(
                    state.computer.execute(request.action).await?,
                )?)
            }
            .await
        }
        other => Err(anyhow::anyhow!("unsupported local job kind {other:?}")),
    };

    match result {
        Ok(output) => {
            let _ = state.jobs.complete(job_id, output);
        }
        Err(error) => {
            let _ = state.jobs.fail(job_id, error.to_string());
        }
    }
}

fn spawn_job(state: Arc<AppState>, job_id: Uuid) {
    tokio::spawn(execute_job(state, job_id));
}

async fn scheduler_loop(state: Arc<AppState>) {
    loop {
        match state.scheduler.dispatch_due(&state.jobs, Utc::now()) {
            Ok(job_ids) => {
                for job_id in job_ids {
                    spawn_job(state.clone(), job_id);
                }
            }
            Err(error) => eprintln!("scheduler dispatch failed: {error:#}"),
        }
        sleep(Duration::from_secs(1)).await;
    }
}

fn reconcile_recovered_jobs(state: &Arc<AppState>) {
    for job in state.jobs.list() {
        match job.status {
            JobStatus::Queued => spawn_job(state.clone(), job.id),
            JobStatus::Running => {
                let _ = state.jobs.fail(
                    job.id,
                    "runtime restarted before completion; previous outcome is unknown",
                );
            }
            _ => {}
        }
    }
}

async fn ui() -> Html<&'static str> {
    Html(UI_HTML)
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "runtime": "zero3-pilot-node"
    }))
}

async fn status(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let schedules = state.scheduler.list().map_err(ApiError::internal)?;
    let memories = state.memory.list(None).map_err(ApiError::internal)?;
    Ok(Json(json!({
        "status": "ok",
        "version": VERSION,
        "data_dir": state.data_dir,
        "jobs": state.jobs.list().len(),
        "schedules": schedules.len(),
        "memories": memories.len(),
        "agents": state.agents.list(),
        "browser": {
            "name": state.browser.name(),
            "capabilities": state.browser.capabilities(),
        },
        "computer": {
            "name": state.computer.name(),
            "capabilities": state.computer.capabilities(),
        },
        "recovery_tail": state.recovery_tail,
    })))
}

async fn list_jobs(State(state): State<Arc<AppState>>) -> Json<Vec<JobRecord>> {
    Json(state.jobs.list())
}

async fn get_job(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<JobRecord>, ApiError> {
    state
        .jobs
        .get(id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found")))
}

async fn submit_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<AgentRunRequest>,
) -> Result<(StatusCode, Json<AcceptedJob>), ApiError> {
    enforce_origin(&headers, &state)?;
    action_gate(
        request.approval.granted_level,
        request.approval.approved,
        "subagent",
        "dispatch",
        PermissionLevel::Elevated,
        true,
    )?;
    if request.goal.trim().is_empty() {
        return Err(ApiError::bad_request("agent goal must not be empty"));
    }
    if state.agents.get(&request.backend).is_none() {
        return Err(ApiError::bad_request(format!(
            "unknown agent backend {:?}",
            request.backend
        )));
    }
    let job_id = state
        .jobs
        .create(
            "subagent",
            serde_json::to_value(request).map_err(ApiError::internal)?,
            None,
        )
        .map_err(ApiError::internal)?;
    spawn_job(state, job_id);
    Ok((StatusCode::ACCEPTED, Json(AcceptedJob { job_id })))
}

async fn submit_browser(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<BrowserRunRequest>,
) -> Result<(StatusCode, Json<AcceptedJob>), ApiError> {
    enforce_origin(&headers, &state)?;
    let (action, level, reversible) = browser_policy(&request.action);
    action_gate(
        request.approval.granted_level,
        request.approval.approved,
        "browser",
        action,
        level,
        reversible,
    )?;
    let job_id = state
        .jobs
        .create(
            "browser",
            serde_json::to_value(request).map_err(ApiError::internal)?,
            None,
        )
        .map_err(ApiError::internal)?;
    spawn_job(state, job_id);
    Ok((StatusCode::ACCEPTED, Json(AcceptedJob { job_id })))
}

async fn submit_computer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ComputerRunRequest>,
) -> Result<(StatusCode, Json<AcceptedJob>), ApiError> {
    enforce_origin(&headers, &state)?;
    let (action, level, reversible) = computer_policy(&request.action);
    action_gate(
        request.approval.granted_level,
        request.approval.approved,
        "computer",
        action,
        level,
        reversible,
    )?;
    let job_id = state
        .jobs
        .create(
            "computer",
            serde_json::to_value(request).map_err(ApiError::internal)?,
            None,
        )
        .map_err(ApiError::internal)?;
    spawn_job(state, job_id);
    Ok((StatusCode::ACCEPTED, Json(AcceptedJob { job_id })))
}

async fn list_schedules(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ScheduledTask>>, ApiError> {
    state.scheduler.list().map(Json).map_err(ApiError::internal)
}

async fn create_schedule(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ScheduleCreateRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    enforce_origin(&headers, &state)?;
    action_gate(
        request.approval.granted_level,
        request.approval.approved,
        "scheduler",
        "create",
        PermissionLevel::Elevated,
        true,
    )?;
    if !matches!(
        request.job_kind.as_str(),
        "subagent" | "browser" | "computer"
    ) {
        return Err(ApiError::bad_request(
            "schedule job_kind must be subagent, browser, or computer",
        ));
    }
    let id = state
        .scheduler
        .schedule(
            request.job_kind,
            request.payload,
            request.schedule,
            request.first_run_at,
        )
        .map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(json!({"schedule_id": id}))))
}

async fn set_schedule_enabled(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ScheduleEnabledRequest>,
) -> Result<Json<Value>, ApiError> {
    enforce_origin(&headers, &state)?;
    let changed = state
        .scheduler
        .set_enabled(id, request.enabled)
        .map_err(ApiError::internal)?;
    if !changed {
        return Err(ApiError::not_found(format!("schedule {id} not found")));
    }
    Ok(Json(json!({"schedule_id": id, "enabled": request.enabled})))
}

async fn delete_schedule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    enforce_origin(&headers, &state)?;
    if state.scheduler.delete(id).map_err(ApiError::internal)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found(format!("schedule {id} not found")))
    }
}

async fn list_memory(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MemoryQuery>,
) -> Result<Json<Vec<MemoryRecord>>, ApiError> {
    let scope = scope_from_query(&query)?;
    let records = match query
        .query
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(text) => state.memory.search(text, scope.as_ref()),
        None => state.memory.list(scope.as_ref()),
    }
    .map_err(ApiError::internal)?;
    Ok(Json(records))
}

async fn put_memory(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<MemoryPutRequest>,
) -> Result<StatusCode, ApiError> {
    enforce_origin(&headers, &state)?;
    let record = match request.class {
        MemoryClass::Operational => {
            MemoryRecord::operational(request.key, request.value, request.scope, request.source)
        }
        MemoryClass::Personal => MemoryRecord::personal(
            request.key,
            request.value,
            request.scope,
            request.source,
            request.approved,
        ),
    };
    state.memory.put(record).map_err(|error| {
        if error.to_string().contains("requires explicit approval") {
            ApiError::approval_required(error.to_string())
        } else {
            ApiError::internal(error)
        }
    })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_memory(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MemoryQuery>,
) -> Result<StatusCode, ApiError> {
    enforce_origin(&headers, &state)?;
    let scope = scope_from_query(&query)?.unwrap_or(MemoryScope::Global);
    if state
        .memory
        .delete(&key, &scope)
        .map_err(ApiError::internal)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found(format!("memory {key:?} not found")))
    }
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(ui))
        .route("/health", get(health))
        .route("/api/v1/status", get(status))
        .route("/api/v1/jobs", get(list_jobs))
        .route("/api/v1/jobs/:id", get(get_job))
        .route("/api/v1/jobs/agent", post(submit_agent))
        .route("/api/v1/jobs/browser", post(submit_browser))
        .route("/api/v1/jobs/computer", post(submit_computer))
        .route(
            "/api/v1/schedules",
            get(list_schedules).post(create_schedule),
        )
        .route(
            "/api/v1/schedules/:id",
            patch(set_schedule_enabled).delete(delete_schedule),
        )
        .route("/api/v1/memory", get(list_memory).post(put_memory))
        .route("/api/v1/memory/:key", delete(delete_memory))
        .with_state(state)
}

fn resolve_data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("ZERO3_PILOT_DATA_DIR") {
        return PathBuf::from(path);
    }
    if cfg!(windows) {
        if let Some(path) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(path).join("Zero3Pilot");
        }
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path).join("zero3-pilot");
    }
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path).join(".local/share/zero3-pilot");
    }
    PathBuf::from(".zero3-pilot")
}

fn env_executable(name: &str, fallback: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn build_state(data_dir: &FsPath, port: u16) -> anyhow::Result<Arc<AppState>> {
    std::fs::create_dir_all(data_dir)?;
    let event_store = Arc::new(EventStore::open(data_dir.join("events.jsonl"))?);
    let (jobs, truncated_tail) =
        JobManager::recover_with_mode(event_store, RecoveryMode::RecoverCrashTail)?;
    let scheduler = PersistentScheduler::open(data_dir.join("scheduler.sqlite"))?;
    let memory = SqliteMemoryStore::open(data_dir.join("memory.sqlite"))?;

    let agents = Arc::new(SubagentRegistry::new());
    agents.register(Arc::new(CodexWorker::new(CliWorkerConfig::new(
        env_executable("ZERO3_CODEX_BIN", "codex"),
    ))));
    agents.register(Arc::new(ClaudeWorker::new(CliWorkerConfig::new(
        env_executable("ZERO3_CLAUDE_BIN", "claude"),
    ))));
    agents.register(Arc::new(HermesWorker::new(CliWorkerConfig::new(
        env_executable("ZERO3_HERMES_BIN", "hermes"),
    ))));

    let browser = Arc::new(CdpBrowserProvider::new());
    let computer = Arc::new(OpenComputerUseAdapter::new(env_executable(
        "ZERO3_OCU_BIN",
        if cfg!(windows) {
            "open-computer-use.cmd"
        } else {
            "open-computer-use"
        },
    )));

    Ok(Arc::new(AppState {
        jobs: Arc::new(jobs),
        scheduler: Arc::new(scheduler),
        memory: Arc::new(memory),
        agents,
        browser,
        computer,
        data_dir: data_dir.to_path_buf(),
        recovery_tail: truncated_tail.map(|tail| format!("{tail:?}")),
        allowed_origins: vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ],
    }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("ZERO3_PILOT_NODE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let data_dir = resolve_data_dir();
    let state = build_state(&data_dir, port)?;
    reconcile_recovered_jobs(&state);
    tokio::spawn(scheduler_loop(state.clone()));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!(
        "zero3-pilot-node listening on http://{addr} data_dir={}",
        data_dir.display()
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(state)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn health_and_status_work_on_an_isolated_local_state() {
        let dir = tempdir().unwrap();
        let state = build_state(dir.path(), 8790).unwrap();
        let app = router(state);

        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let status = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
    }

    #[test]
    fn policy_requires_approval_for_side_effecting_computer_action() {
        let request = ComputerAction::Click {
            app: "Notepad".into(),
            x: 10,
            y: 20,
        };
        let (action, level, reversible) = computer_policy(&request);
        assert!(action_gate(
            PermissionLevel::Standard,
            false,
            "computer",
            action,
            level,
            reversible,
        )
        .is_err());
        assert!(action_gate(
            PermissionLevel::Standard,
            true,
            "computer",
            action,
            level,
            reversible,
        )
        .is_ok());
    }

    #[test]
    fn foreign_browser_origin_is_rejected() {
        let dir = tempdir().unwrap();
        let state = build_state(dir.path(), 8790).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("origin", "https://evil.example".parse().unwrap());
        assert!(enforce_origin(&headers, &state).is_err());
    }
}
