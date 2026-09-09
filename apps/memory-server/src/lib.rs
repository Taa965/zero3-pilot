pub mod auth;

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, Mutex};
use tokio_postgres::NoTls;

pub use auth::AuthPolicy;
use auth::{AuthFailure, AuthGrant};

pub const EVENT_SCHEMA: &str = "zero3.memory.event.v1";
pub const SYNC_PROTOCOL: &str = "zero3.memory.sync.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryScope {
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryActor {
    pub agent_id: String,
    pub agent_type: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryMeta {
    pub class: String,
    pub entity_type: String,
    pub entity_id: String,
    pub authority: u8,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub expected_entity_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemorySource {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryEvent {
    pub schema: String,
    pub event_id: String,
    pub created_at: String,
    pub scope: MemoryScope,
    pub actor: MemoryActor,
    pub event_type: String,
    pub memory: MemoryMeta,
    pub source: MemorySource,
    #[serde(default)]
    pub supersedes: Vec<String>,
    pub payload: Value,
}

impl MemoryEvent {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.schema != EVENT_SCHEMA {
            return Err(anyhow!("unsupported event schema"));
        }
        if self.event_id.trim().is_empty() || self.actor.agent_id.trim().is_empty() {
            return Err(anyhow!("event_id and actor.agent_id are required"));
        }
        if self.memory.entity_id.trim().is_empty() || self.memory.entity_type.trim().is_empty() {
            return Err(anyhow!("memory entity id/type are required"));
        }
        if self.memory.authority == 100 && self.actor.agent_type != "system" {
            return Err(anyhow!("agents cannot self-assert user authority"));
        }
        if !is_uuid(&self.event_id)
            || chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err()
            || !self.payload.is_object()
            || self.memory.authority > 100
            || self
                .memory
                .confidence
                .is_some_and(|v| !(0.0..=1.0).contains(&v))
            || self.supersedes.len() > 64
            || self.supersedes.iter().any(|id| !is_uuid(id))
        {
            return Err(anyhow!("invalid memory event fields"));
        }
        if !matches!(
            self.memory.class.as_str(),
            "project" | "task" | "global" | "scratch" | "audit" | "personal"
        ) {
            return Err(anyhow!("invalid memory class"));
        }
        if matches!(self.memory.class.as_str(), "project" | "task")
            && (self
                .scope
                .project_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty()))
        {
            return Err(anyhow!("project scope is required"));
        }
        if self.memory.class == "task"
            && self
                .scope
                .task_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty())
        {
            return Err(anyhow!("task scope is required"));
        }
        Ok(())
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| {
            if [8, 13, 18, 23].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommittedEvent {
    pub sequence: i64,
    pub event: MemoryEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AppendStatus {
    Accepted,
    Duplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppendOutcome {
    pub event_id: String,
    pub status: AppendStatus,
    pub sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectContext {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub version: i64,
    pub payload: Value,
    pub sync: SyncInfo,
    pub entities: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncInfo {
    pub source: String,
    pub last_sequence: i64,
    pub stale: bool,
}

#[async_trait]
pub trait MemoryRepository: Send + Sync + 'static {
    async fn append(&self, event: MemoryEvent) -> anyhow::Result<AppendOutcome>;
    async fn events_after(
        &self,
        sequence: i64,
        projects: &[String],
    ) -> anyhow::Result<Vec<CommittedEvent>>;
    async fn latest_sequence(&self) -> anyhow::Result<i64>;
    async fn project_context(&self, project_id: &str) -> anyhow::Result<ProjectContext>;
    async fn ready(&self) -> anyhow::Result<()>;
}

#[derive(Default)]
struct InMemoryState {
    sequence: i64,
    events: Vec<CommittedEvent>,
    by_id: HashMap<String, i64>,
}

#[derive(Default)]
pub struct InMemoryRepository {
    state: Mutex<InMemoryState>,
}

#[async_trait]
impl MemoryRepository for InMemoryRepository {
    async fn append(&self, event: MemoryEvent) -> anyhow::Result<AppendOutcome> {
        event.validate()?;
        let mut state = self.state.lock().await;
        if let Some(sequence) = state.by_id.get(&event.event_id).copied() {
            return Ok(AppendOutcome {
                event_id: event.event_id,
                status: AppendStatus::Duplicate,
                sequence,
            });
        }
        state.sequence += 1;
        let sequence = state.sequence;
        state.by_id.insert(event.event_id.clone(), sequence);
        state.events.push(CommittedEvent {
            sequence,
            event: event.clone(),
        });
        Ok(AppendOutcome {
            event_id: event.event_id,
            status: AppendStatus::Accepted,
            sequence,
        })
    }

    async fn events_after(
        &self,
        sequence: i64,
        projects: &[String],
    ) -> anyhow::Result<Vec<CommittedEvent>> {
        let allow: HashSet<&str> = projects.iter().map(String::as_str).collect();
        Ok(self
            .state
            .lock()
            .await
            .events
            .iter()
            .filter(|item| item.sequence > sequence)
            .filter(|item| {
                item.event
                    .scope
                    .project_id
                    .as_deref()
                    .is_some_and(|id| allow.contains(id))
            })
            .cloned()
            .collect())
    }

    async fn latest_sequence(&self) -> anyhow::Result<i64> {
        Ok(self.state.lock().await.sequence)
    }

    async fn project_context(&self, project_id: &str) -> anyhow::Result<ProjectContext> {
        let state = self.state.lock().await;
        let mut decisions = Vec::new();
        let mut pitfalls = Vec::new();
        let mut constraints = Vec::new();
        let mut policies = Vec::new();
        let mut glossary = Map::new();
        let mut current_focus = Value::Null;
        let mut version = 0_i64;
        let mut last_sequence = 0_i64;

        for item in state
            .events
            .iter()
            .filter(|item| item.event.scope.project_id.as_deref() == Some(project_id))
        {
            version += 1;
            last_sequence = item.sequence;
            match item.event.event_type.as_str() {
                "decision.recorded" => decisions.push(item.event.payload.clone()),
                "pitfall.recorded" => pitfalls.push(item.event.payload.clone()),
                "constraint.recorded" => constraints.push(item.event.payload.clone()),
                "policy.recorded" => policies.push(item.event.payload.clone()),
                "focus.changed" => current_focus = item.event.payload.clone(),
                "glossary.updated" => {
                    if let (Some(term), Some(value)) = (
                        item.event.payload.get("term").and_then(Value::as_str),
                        item.event.payload.get("value"),
                    ) {
                        glossary.insert(term.to_owned(), value.clone());
                    }
                }
                _ => {}
            }
        }

        Ok(ProjectContext {
            project_id: project_id.to_owned(),
            version,
            payload: json!({
                "decisions": decisions,
                "currentFocus": current_focus,
                "pitfalls": pitfalls,
                "glossary": glossary,
                "constraints": constraints,
                "policies": policies
            }),
            sync: SyncInfo {
                source: "memory_server".into(),
                last_sequence,
                stale: false,
            },
            entities: Vec::new(),
        })
    }

    async fn ready(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct PostgresRepository {
    dsn: Arc<str>,
}

impl PostgresRepository {
    pub fn new(dsn: impl Into<Arc<str>>) -> Self {
        Self { dsn: dsn.into() }
    }

    async fn client(&self) -> anyhow::Result<tokio_postgres::Client> {
        let (client, connection) = tokio_postgres::connect(&self.dsn, NoTls)
            .await
            .context("connect memory postgres")?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::error!(%error, "memory postgres connection ended");
            }
        });
        Ok(client)
    }
}

#[async_trait]
impl MemoryRepository for PostgresRepository {
    async fn append(&self, event: MemoryEvent) -> anyhow::Result<AppendOutcome> {
        event.validate()?;
        let client = self.client().await?;
        let authority = i16::from(event.memory.authority);
        let expected_entity_version = event
            .memory
            .expected_entity_version
            .map(i64::try_from)
            .transpose()
            .context("expected entity version exceeds PostgreSQL bigint")?;
        let supersedes = event.supersedes.clone();
        let inserted = client.query_opt(
            "INSERT INTO memory_events (event_id, project_id, task_id, session_id, thread_id, agent_id, agent_type, device_id, event_type, memory_class, authority, confidence, entity_type, entity_id, expected_entity_version, supersedes, payload, source_type, source_ref, source_hash, created_at) VALUES ($1::text::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::double precision,$13,$14,$15,$16::text[]::uuid[],$17,$18,$19,$20,$21::text::timestamptz) ON CONFLICT (event_id) DO NOTHING RETURNING sequence",
            &[
                &event.event_id, &event.scope.project_id, &event.scope.task_id, &event.scope.session_id,
                &event.scope.thread_id, &event.actor.agent_id, &event.actor.agent_type, &event.actor.device_id,
                &event.event_type, &event.memory.class, &authority, &event.memory.confidence,
                &event.memory.entity_type, &event.memory.entity_id, &expected_entity_version, &supersedes,
                &event.payload, &event.source.kind, &event.source.r#ref, &event.source.hash,
                &event.created_at,
            ],
        ).await.context("append memory event")?;

        if let Some(row) = inserted {
            return Ok(AppendOutcome {
                event_id: event.event_id,
                status: AppendStatus::Accepted,
                sequence: row.get(0),
            });
        }
        let row = client
            .query_one(
                "SELECT sequence FROM memory_events WHERE event_id = $1::text::uuid",
                &[&event.event_id],
            )
            .await?;
        Ok(AppendOutcome {
            event_id: event.event_id,
            status: AppendStatus::Duplicate,
            sequence: row.get(0),
        })
    }

    async fn events_after(
        &self,
        sequence: i64,
        projects: &[String],
    ) -> anyhow::Result<Vec<CommittedEvent>> {
        if projects.is_empty() {
            return Ok(Vec::new());
        }
        let client = self.client().await?;
        let rows = client.query(
            "SELECT sequence, event_id::text, created_at::text, project_id, task_id, session_id, thread_id, agent_id, agent_type, device_id, event_type, memory_class, authority, confidence::double precision, entity_type, entity_id, supersedes::text[], payload, source_type, source_ref, source_hash, expected_entity_version FROM memory_events WHERE sequence > $1 AND project_id = ANY($2) ORDER BY sequence ASC LIMIT 5000",
            &[&sequence, &projects],
        ).await?;
        rows.into_iter()
            .map(|row| {
                let authority: i16 = row.get(12);
                Ok(CommittedEvent {
                    sequence: row.get(0),
                    event: MemoryEvent {
                        schema: EVENT_SCHEMA.into(),
                        event_id: row.get(1),
                        created_at: row.get(2),
                        scope: MemoryScope {
                            project_id: row.get(3),
                            task_id: row.get(4),
                            session_id: row.get(5),
                            thread_id: row.get(6),
                        },
                        actor: MemoryActor {
                            agent_id: row.get(7),
                            agent_type: row.get(8),
                            device_id: row.get(9),
                        },
                        event_type: row.get(10),
                        memory: MemoryMeta {
                            class: row.get(11),
                            entity_type: row.get(14),
                            entity_id: row.get(15),
                            authority: u8::try_from(authority)
                                .map_err(|_| anyhow!("invalid stored authority"))?,
                            confidence: row.get(13),
                            expected_entity_version: row
                                .get::<_, Option<i64>>(21)
                                .map(|v| v as u64),
                        },
                        source: MemorySource {
                            kind: row.get(18),
                            r#ref: row.get(19),
                            hash: row.get(20),
                        },
                        supersedes: row.get(16),
                        payload: row.get(17),
                    },
                })
            })
            .collect()
    }

    async fn latest_sequence(&self) -> anyhow::Result<i64> {
        let client = self.client().await?;
        Ok(client
            .query_one(
                "SELECT COALESCE(MAX(sequence), 0)::bigint FROM memory_events",
                &[],
            )
            .await?
            .get(0))
    }

    async fn project_context(&self, project_id: &str) -> anyhow::Result<ProjectContext> {
        let client = self.client().await?;
        let mut client = client;
        let transaction = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let row = transaction.query_opt("SELECT version, decisions, current_focus, pitfalls, glossary, constraints, policies, last_sequence FROM project_memory_projection WHERE project_id = $1", &[&project_id]).await?;
        let entities = transaction.query("SELECT jsonb_build_object('entity_id', m.entity_id, 'entity_type', m.entity_type, 'memory_class', m.memory_class, 'task_id', m.task_id, 'version', m.current_version, 'authority', m.authority, 'verification_status', m.verification_status, 'content', m.content, 'updated_sequence', e.sequence) FROM memory_entities m JOIN memory_events e ON e.event_id=m.source_event_id WHERE m.project_id=$1 ORDER BY e.sequence, m.entity_id", &[&project_id]).await?
            .into_iter().map(|row| row.get::<_, Value>(0)).collect();
        transaction.commit().await?;
        let Some(row) = row else {
            return Ok(ProjectContext {
                project_id: project_id.into(),
                version: 0,
                payload: Value::Null,
                sync: SyncInfo {
                    source: "memory_server".into(),
                    last_sequence: 0,
                    stale: false,
                },
                entities,
            });
        };
        let last_sequence: i64 = row.get(7);
        Ok(ProjectContext {
            project_id: project_id.into(),
            version: row.get(0),
            payload: json!({"decisions": row.get::<_, Value>(1), "currentFocus": row.get::<_, Option<Value>>(2), "pitfalls": row.get::<_, Value>(3), "glossary": row.get::<_, Value>(4), "constraints": row.get::<_, Value>(5), "policies": row.get::<_, Value>(6)}),
            sync: SyncInfo {
                source: "memory_server".into(),
                last_sequence,
                stale: false,
            },
            entities,
        })
    }

    async fn ready(&self) -> anyhow::Result<()> {
        self.client()
            .await?
            .query_one("SELECT count(*) FROM memory_events WHERE false", &[])
            .await?;
        Ok(())
    }
}

#[derive(Clone)]
struct AppState {
    repo: Arc<dyn MemoryRepository>,
    bus: broadcast::Sender<CommittedEvent>,
    auth: AuthPolicy,
}

pub fn router(repo: Arc<dyn MemoryRepository>, auth: AuthPolicy) -> Router {
    let (bus, _) = broadcast::channel(1024);
    let state = AppState { repo, bus, auth };
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/v1/memory/events", post(append_event).get(read_events))
        .route("/v1/memory/events:batch", post(append_batch))
        .route("/v1/projects/:project_id/context", get(project_context))
        .route("/v1/sync", get(sync_upgrade))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok", "service": "zero3-memory-authority", "protocol": "v2.1"}))
}

async fn ready(State(state): State<AppState>) -> Response {
    match state.repo.ready().await {
        Ok(()) => (StatusCode::OK, Json(json!({"status":"ready"}))).into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"not_ready","error":error.to_string()})),
        )
            .into_response(),
    }
}

fn auth_failure_response(failure: AuthFailure) -> Response {
    (failure.status, Json(json!({"error": failure.code}))).into_response()
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<AuthGrant, AuthFailure> {
    state.auth.authenticate(headers)
}

fn authorize_event(grant: &AuthGrant, event: &MemoryEvent) -> Result<(), AuthFailure> {
    grant.authorize_event(
        event.scope.project_id.as_deref(),
        &event.memory.class,
        &event.actor.agent_type,
        event.memory.authority,
    )
}

fn repository_error_code(error: &anyhow::Error) -> (&'static str, bool) {
    for cause in error.chain() {
        let message = cause.to_string();
        if message.contains("entity_version_conflict") {
            return ("entity_version_conflict", true);
        }
        if message.contains("authority_conflict") {
            return ("authority_conflict", true);
        }
        if let Some(error) = cause.downcast_ref::<tokio_postgres::Error>() {
            if let Some(db) = error.as_db_error() {
                match db.message() {
                    "entity_version_conflict" => return ("entity_version_conflict", true),
                    "authority_conflict" => return ("authority_conflict", true),
                    _ => {}
                }
            }
            if error.as_db_error().is_none()
                || error
                    .code()
                    .is_some_and(|code| matches!(&code.code()[..2], "08" | "40" | "53" | "57"))
            {
                return ("memory_unavailable", false);
            }
        }
    }
    ("memory_event_rejected", false)
}

fn forbidden_secret_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().replace('-', "_").as_str(),
        "password"
            | "passwd"
            | "secret"
            | "api_key"
            | "access_token"
            | "refresh_token"
            | "authorization"
            | "cookie"
            | "session_cookie"
            | "private_key"
            | "client_secret"
            | "bearer"
    )
}

fn looks_like_secret(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with("sk-") && trimmed.len() >= 20)
        || (trimmed.starts_with("ghp_") && trimmed.len() >= 20)
        || (trimmed.starts_with("github_pat_") && trimmed.len() >= 24)
        || (trimmed.starts_with("AKIA") && trimmed.len() >= 20)
        || trimmed.contains("-----BEGIN PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN RSA PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN EC PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
        || (trimmed.to_ascii_lowercase().starts_with("bearer ") && trimmed.len() >= 24)
        || (trimmed.starts_with("eyJ") && trimmed.split('.').count() == 3 && trimmed.len() >= 32)
}

fn validate_secret_free(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if forbidden_secret_key(key) {
                    return Err("secret_detected");
                }
                validate_secret_free(child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate_secret_free(child)?;
            }
        }
        Value::String(text) if looks_like_secret(text) => return Err("secret_detected"),
        _ => {}
    }
    Ok(())
}

fn validate_shared_event(event: &MemoryEvent) -> Result<(), &'static str> {
    if event.memory.class == "personal" {
        return Err("personal_memory_requires_separate_boundary");
    }
    validate_secret_free(&serde_json::to_value(event).map_err(|_| "invalid_event")?)
}

async fn append_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(event): Json<MemoryEvent>,
) -> Response {
    let grant = match authenticate(&state, &headers) {
        Ok(grant) => grant,
        Err(failure) => return auth_failure_response(failure),
    };
    if let Err(failure) = authorize_event(&grant, &event) {
        return auth_failure_response(failure);
    }
    if let Err(code) = validate_shared_event(&event) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": code}))).into_response();
    }
    match state.repo.append(event.clone()).await {
        Ok(outcome) => {
            if outcome.status == AppendStatus::Accepted {
                let _ = state.bus.send(CommittedEvent {
                    sequence: outcome.sequence,
                    event,
                });
            }
            (StatusCode::OK, Json(json!(outcome))).into_response()
        }
        Err(error) => {
            let (code, conflict) = repository_error_code(&error);
            let status = if conflict {
                StatusCode::CONFLICT
            } else if code == "memory_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            };
            (
                status,
                Json(json!({"error":code,"message":error.to_string()})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct BatchRequest {
    events: Vec<MemoryEvent>,
}

async fn append_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(batch): Json<BatchRequest>,
) -> Response {
    let grant = match authenticate(&state, &headers) {
        Ok(grant) => grant,
        Err(failure) => return auth_failure_response(failure),
    };
    let mut results = Vec::with_capacity(batch.events.len());
    for event in batch.events {
        if let Err(failure) = grant.authorize_event(
            event.scope.project_id.as_deref(),
            &event.memory.class,
            &event.actor.agent_type,
            event.memory.authority,
        ) {
            results.push(
                json!({"event_id": event.event_id, "status":"rejected", "error": failure.code}),
            );
            continue;
        }
        if let Err(code) = validate_shared_event(&event) {
            results.push(json!({"event_id": event.event_id, "status":"rejected", "error": code}));
            continue;
        }
        match state.repo.append(event.clone()).await {
            Ok(outcome) => {
                if outcome.status == AppendStatus::Accepted {
                    let _ = state.bus.send(CommittedEvent {
                        sequence: outcome.sequence,
                        event,
                    });
                }
                results.push(json!(outcome));
            }
            Err(error) => {
                let (code, conflict) = repository_error_code(&error);
                results.push(json!({
                    "event_id": event.event_id,
                    "status": if conflict { "conflict" } else if code == "memory_unavailable" { "retryable" } else { "rejected" },
                    "error": code
                }));
            }
        }
    }
    Json(json!({"results":results})).into_response()
}

async fn project_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Response {
    let grant = match authenticate(&state, &headers) {
        Ok(grant) => grant,
        Err(failure) => return auth_failure_response(failure),
    };
    if !grant.allows_project(&project_id) {
        return auth_failure_response(AuthFailure {
            status: StatusCode::FORBIDDEN,
            code: "project_denied",
        });
    }
    match state.repo.project_context(&project_id).await {
        Ok(context) => (StatusCode::OK, Json(json!(context))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"context_read_failed","message":error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct ReplayQuery {
    project_id: String,
    #[serde(default)]
    after: i64,
}

async fn read_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReplayQuery>,
) -> Response {
    let grant = match authenticate(&state, &headers) {
        Ok(grant) => grant,
        Err(failure) => return auth_failure_response(failure),
    };
    if !grant.allows_project(&query.project_id) {
        return auth_failure_response(AuthFailure {
            status: StatusCode::FORBIDDEN,
            code: "project_denied",
        });
    }
    if query.after < 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_cursor"})),
        )
            .into_response();
    }
    match state
        .repo
        .events_after(query.after, &[query.project_id])
        .await
    {
        Ok(events) => Json(json!({"events":events})).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"replay_unavailable"})),
        )
            .into_response(),
    }
}

async fn sync_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let grant = match authenticate(&state, &headers) {
        Ok(grant) => grant,
        Err(failure) => return auth_failure_response(failure),
    };
    ws.on_upgrade(move |socket| sync_socket(socket, state, grant))
        .into_response()
}

#[derive(Debug, Deserialize)]
struct SyncHello {
    #[serde(rename = "type")]
    kind: String,
    protocol: String,
    client_id: String,
    device_id: String,
    last_sequence: i64,
    projects: Vec<String>,
}

async fn sync_socket(mut socket: WebSocket, state: AppState, grant: AuthGrant) {
    let Some(Ok(Message::Text(text))) = socket.recv().await else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<SyncHello>(&text) else {
        let _ = socket.send(Message::Text(json!({"type":"error","code":"invalid_hello","message":"first frame must be hello"}).to_string())).await;
        return;
    };
    if hello.kind != "hello"
        || hello.protocol != SYNC_PROTOCOL
        || hello.client_id.is_empty()
        || hello.device_id.is_empty()
        || hello.last_sequence < 0
    {
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","code":"invalid_hello","message":"invalid sync hello"})
                    .to_string(),
            ))
            .await;
        return;
    }
    if hello.client_id != *grant.client_id {
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","code":"client_id_mismatch","message":"sync client_id is not bound to this bearer grant"}).to_string(),
            ))
            .await;
        return;
    }
    if let Err(failure) = grant.authorize_projects(&hello.projects) {
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","code": failure.code,"message":"sync project subscription is not authorized"}).to_string(),
            ))
            .await;
        return;
    }

    // Subscribe before catchup; durable replay, rather than publication order,
    // determines the cursor. Polling also observes writes from other replicas.
    let mut receiver = state.bus.subscribe();
    let mut cursor = hello.last_sequence;
    if send_catchup(&mut socket, &state, &hello.projects, &mut cursor)
        .await
        .is_err()
    {
        return;
    }
    if socket
        .send(Message::Text(
            json!({"type":"ready","latest_sequence":cursor}).to_string(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut poll = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = match serde_json::from_str(&text) { Ok(value) => value, Err(_) => continue };
                    match value.get("type").and_then(Value::as_str) {
                        Some("ping") => {
                            let at = value.get("at").cloned().unwrap_or_else(|| json!(chrono::Utc::now().to_rfc3339()));
                            if socket.send(Message::Text(json!({"type":"pong","at":at}).to_string())).await.is_err() { break; }
                        }
                        Some("ack") => {}
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            published = receiver.recv() => match published {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    if send_catchup(&mut socket, &state, &hello.projects, &mut cursor).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = poll.tick() => {
                if send_catchup(&mut socket, &state, &hello.projects, &mut cursor).await.is_err() { break; }
            }
        }
    }
}

async fn send_catchup(
    socket: &mut WebSocket,
    state: &AppState,
    projects: &[String],
    cursor: &mut i64,
) -> anyhow::Result<()> {
    loop {
        let events = state.repo.events_after(*cursor, projects).await?;
        let Some(last) = events.last() else {
            return Ok(());
        };
        let next = last.sequence;
        if next <= *cursor {
            return Err(anyhow!("non-monotonic memory replay"));
        }
        socket
            .send(Message::Text(
                json!({
                    "type":"events", "from_sequence":events[0].sequence,
                    "to_sequence":next, "events":events
                })
                .to_string(),
            ))
            .await?;
        *cursor = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TEST_TOKEN: &str = "abcdefghijklmnopqrstuvwxyz123456";

    fn test_auth() -> AuthPolicy {
        AuthPolicy::from_json(
            r#"[{"token":"abcdefghijklmnopqrstuvwxyz123456","client_id":"pilot-test","projects":["project-a"],"agent_types":["codex"],"max_authority":60,"allow_global":false,"allow_personal":false}]"#,
        )
        .unwrap()
    }

    fn authorized(builder: axum::http::request::Builder) -> axum::http::request::Builder {
        builder.header("authorization", format!("Bearer {TEST_TOKEN}"))
    }

    fn sample_event(id: &str, event_type: &str) -> MemoryEvent {
        MemoryEvent {
            schema: EVENT_SCHEMA.into(),
            event_id: id.into(),
            created_at: "2026-09-08T03:00:00Z".into(),
            scope: MemoryScope {
                project_id: Some("project-a".into()),
                task_id: None,
                session_id: None,
                thread_id: None,
            },
            actor: MemoryActor {
                agent_id: "codex-1".into(),
                agent_type: "codex".into(),
                device_id: Some("desktop".into()),
            },
            event_type: event_type.into(),
            memory: MemoryMeta {
                class: "project".into(),
                entity_type: "decision".into(),
                entity_id: id.into(),
                authority: 60,
                confidence: Some(0.9),
                expected_entity_version: Some(0),
            },
            source: MemorySource {
                kind: "task".into(),
                r#ref: Some("task-1".into()),
                hash: None,
            },
            supersedes: Vec::new(),
            payload: json!({"text":"hello"}),
        }
    }

    #[tokio::test]
    async fn append_is_idempotent_and_context_is_projected() {
        let app = router(Arc::new(InMemoryRepository::default()), test_auth());
        let event = sample_event("11111111-1111-4111-8111-111111111111", "decision.recorded");
        for expected in ["accepted", "duplicate"] {
            let response = app
                .clone()
                .oneshot(
                    authorized(Request::post("/v1/memory/events"))
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&event).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let value: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(value["status"], expected);
        }
        let response = app
            .oneshot(
                authorized(Request::get("/v1/projects/project-a/context"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["payload"]["decisions"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn missing_bearer_token_is_rejected() {
        let app = router(Arc::new(InMemoryRepository::default()), test_auth());
        let event = sample_event("33333333-3333-4333-8333-333333333333", "decision.recorded");
        let response = app
            .oneshot(
                Request::post("/v1/memory/events")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&event).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn shared_event_secret_scanner_is_fail_closed() {
        let mut event = sample_event("44444444-4444-4444-8444-444444444444", "decision.recorded");
        event.payload = json!({"api_key":"ordinary-looking-value"});
        assert_eq!(validate_shared_event(&event), Err("secret_detected"));

        event.payload = json!({"note":"Bearer abcdefghijklmnopqrstuvwxyz012345"});
        assert_eq!(validate_shared_event(&event), Err("secret_detected"));

        event.payload = json!({"note":"ordinary architecture decision"});
        assert_eq!(validate_shared_event(&event), Ok(()));
    }

    #[test]
    fn personal_memory_never_uses_shared_ingress() {
        let mut event = sample_event("55555555-5555-4555-8555-555555555555", "decision.recorded");
        event.memory.class = "personal".into();
        assert_eq!(
            validate_shared_event(&event),
            Err("personal_memory_requires_separate_boundary")
        );
    }

    #[test]
    fn repository_conflicts_are_classified_for_offline_replay() {
        let version_error =
            anyhow!("database rejected: entity_version_conflict").context("append memory event");
        assert_eq!(
            repository_error_code(&version_error),
            ("entity_version_conflict", true)
        );
        let authority_error = anyhow!("authority_conflict").context("append memory event");
        assert_eq!(
            repository_error_code(&authority_error),
            ("authority_conflict", true)
        );
        let invalid = anyhow!("bad payload").context("append memory event");
        assert_eq!(
            repository_error_code(&invalid),
            ("memory_event_rejected", false)
        );
    }

    #[tokio::test]
    async fn user_authority_boundary_is_fail_closed() {
        let app = router(Arc::new(InMemoryRepository::default()), test_auth());
        let mut event = sample_event("22222222-2222-4222-8222-222222222222", "decision.recorded");
        event.memory.authority = 100;
        let response = app
            .oneshot(
                authorized(Request::post("/v1/memory/events"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&event).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
