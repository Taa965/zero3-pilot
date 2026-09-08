import fs from 'node:fs'

const libFile = 'apps/memory-server/src/lib.rs'
let source = fs.readFileSync(libFile, 'utf8')

function replaceOnce(from, to, label) {
  if (source.includes(to)) return
  if (!source.includes(from)) throw new Error(`memory server auth patch drift: ${label}`)
  source = source.replace(from, to)
}

replaceOnce(
  `use std::{\n    collections::{HashMap, HashSet},\n    sync::Arc,\n};`,
  `pub mod auth;\n\nuse std::{\n    collections::{HashMap, HashSet},\n    sync::Arc,\n};`,
  'module export'
)
replaceOnce(
  `    http::StatusCode,`,
  `    http::{HeaderMap, StatusCode},`,
  'HeaderMap import'
)
replaceOnce(
  `use tokio_postgres::NoTls;\n\npub const EVENT_SCHEMA`,
  `use tokio_postgres::NoTls;\n\npub use auth::AuthPolicy;\nuse auth::{AuthFailure, AuthGrant};\n\npub const EVENT_SCHEMA`,
  'auth imports'
)
replaceOnce(
  `struct AppState {\n    repo: Arc<dyn MemoryRepository>,\n    bus: broadcast::Sender<CommittedEvent>,\n}\n\npub fn router(repo: Arc<dyn MemoryRepository>) -> Router {\n    let (bus, _) = broadcast::channel(1024);\n    let state = AppState { repo, bus };`,
  `struct AppState {\n    repo: Arc<dyn MemoryRepository>,\n    bus: broadcast::Sender<CommittedEvent>,\n    auth: AuthPolicy,\n}\n\npub fn router(repo: Arc<dyn MemoryRepository>, auth: AuthPolicy) -> Router {\n    let (bus, _) = broadcast::channel(1024);\n    let state = AppState { repo, bus, auth };`,
  'router auth state'
)

const readyEnd = `async fn ready(State(state): State<AppState>) -> Response {\n    match state.repo.ready().await {\n        Ok(()) => (StatusCode::OK, Json(json!({"status":"ready"}))).into_response(),\n        Err(error) => (\n            StatusCode::SERVICE_UNAVAILABLE,\n            Json(json!({"status":"not_ready","error":error.to_string()})),\n        )\n            .into_response(),\n    }\n}\n`
const helpers = `${readyEnd}\nfn auth_failure_response(failure: AuthFailure) -> Response {\n    (failure.status, Json(json!({"error": failure.code}))).into_response()\n}\n\nfn authenticate(state: &AppState, headers: &HeaderMap) -> Result<AuthGrant, Response> {\n    state.auth.authenticate(headers).map_err(auth_failure_response)\n}\n\nfn authorize_event(grant: &AuthGrant, event: &MemoryEvent) -> Result<(), Response> {\n    grant\n        .authorize_event(\n            event.scope.project_id.as_deref(),\n            &event.memory.class,\n            &event.actor.agent_type,\n            event.memory.authority,\n        )\n        .map_err(auth_failure_response)\n}\n`
replaceOnce(readyEnd, helpers, 'auth helpers')

replaceOnce(
  `async fn append_event(State(state): State<AppState>, Json(event): Json<MemoryEvent>) -> Response {\n    match state.repo.append(event.clone()).await {`,
  `async fn append_event(\n    State(state): State<AppState>,\n    headers: HeaderMap,\n    Json(event): Json<MemoryEvent>,\n) -> Response {\n    let grant = match authenticate(&state, &headers) {\n        Ok(grant) => grant,\n        Err(response) => return response,\n    };\n    if let Err(response) = authorize_event(&grant, &event) {\n        return response;\n    }\n    match state.repo.append(event.clone()).await {`,
  'append auth'
)

replaceOnce(
  `async fn append_batch(\n    State(state): State<AppState>,\n    Json(batch): Json<BatchRequest>,\n) -> Json<Value> {\n    let mut results = Vec::with_capacity(batch.events.len());\n    for event in batch.events {\n        match state.repo.append(event.clone()).await {`,
  `async fn append_batch(\n    State(state): State<AppState>,\n    headers: HeaderMap,\n    Json(batch): Json<BatchRequest>,\n) -> Response {\n    let grant = match authenticate(&state, &headers) {\n        Ok(grant) => grant,\n        Err(response) => return response,\n    };\n    let mut results = Vec::with_capacity(batch.events.len());\n    for event in batch.events {\n        if let Err(failure) = grant.authorize_event(\n            event.scope.project_id.as_deref(),\n            &event.memory.class,\n            &event.actor.agent_type,\n            event.memory.authority,\n        ) {\n            results.push(json!({"event_id": event.event_id, "status":"rejected", "error": failure.code}));\n            continue;\n        }\n        match state.repo.append(event.clone()).await {`,
  'batch auth'
)
replaceOnce(
  `    Json(json!({"results":results}))\n}\n\nasync fn project_context(`,
  `    Json(json!({"results":results})).into_response()\n}\n\nasync fn project_context(`,
  'batch response'
)
replaceOnce(
  `async fn project_context(\n    State(state): State<AppState>,\n    Path(project_id): Path<String>,\n) -> Response {\n    match state.repo.project_context(&project_id).await {`,
  `async fn project_context(\n    State(state): State<AppState>,\n    headers: HeaderMap,\n    Path(project_id): Path<String>,\n) -> Response {\n    let grant = match authenticate(&state, &headers) {\n        Ok(grant) => grant,\n        Err(response) => return response,\n    };\n    if !grant.allows_project(&project_id) {\n        return auth_failure_response(AuthFailure {\n            status: StatusCode::FORBIDDEN,\n            code: "project_denied",\n        });\n    }\n    match state.repo.project_context(&project_id).await {`,
  'context auth'
)
replaceOnce(
  `async fn sync_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {\n    ws.on_upgrade(move |socket| sync_socket(socket, state))\n}`,
  `async fn sync_upgrade(\n    ws: WebSocketUpgrade,\n    State(state): State<AppState>,\n    headers: HeaderMap,\n) -> Response {\n    let grant = match authenticate(&state, &headers) {\n        Ok(grant) => grant,\n        Err(response) => return response,\n    };\n    ws.on_upgrade(move |socket| sync_socket(socket, state, grant))\n        .into_response()\n}`,
  'sync upgrade auth'
)
replaceOnce(
  `async fn sync_socket(mut socket: WebSocket, state: AppState) {`,
  `async fn sync_socket(mut socket: WebSocket, state: AppState, grant: AuthGrant) {`,
  'sync grant param'
)
replaceOnce(
  `    if hello.kind != "hello"\n        || hello.protocol != SYNC_PROTOCOL\n        || hello.client_id.is_empty()\n        || hello.device_id.is_empty()\n        || hello.last_sequence < 0\n    {`,
  `    if hello.kind != "hello"\n        || hello.protocol != SYNC_PROTOCOL\n        || hello.client_id.is_empty()\n        || hello.device_id.is_empty()\n        || hello.last_sequence < 0\n    {`,
  'sync hello unchanged anchor'
)
const helloAfter = `        return;\n    }\n\n    let latest = match state.repo.latest_sequence().await {`
const helloAuth = `        return;\n    }\n    if hello.client_id != &*grant.client_id {\n        let _ = socket\n            .send(Message::Text(\n                json!({"type":"error","code":"client_id_mismatch","message":"sync client_id is not bound to this bearer grant"}).to_string(),\n            ))\n            .await;\n        return;\n    }\n    if let Err(failure) = grant.authorize_projects(&hello.projects) {\n        let _ = socket\n            .send(Message::Text(\n                json!({"type":"error","code": failure.code,"message":"sync project subscription is not authorized"}).to_string(),\n            ))\n            .await;\n        return;\n    }\n\n    let latest = match state.repo.latest_sequence().await {`
replaceOnce(helloAfter, helloAuth, 'sync hello ACL')

// Tests use a scoped test bearer grant and must prove unauthenticated access is rejected.
replaceOnce(
  `    fn sample_event(id: &str, event_type: &str) -> MemoryEvent {`,
  `    const TEST_TOKEN: &str = "abcdefghijklmnopqrstuvwxyz123456";\n\n    fn test_auth() -> AuthPolicy {\n        AuthPolicy::from_json(\n            r#"[{"token":"abcdefghijklmnopqrstuvwxyz123456","client_id":"pilot-test","projects":["project-a"],"agent_types":["codex"],"max_authority":60,"allow_global":false,"allow_personal":false}]"#,\n        )\n        .unwrap()\n    }\n\n    fn authorized(builder: axum::http::request::Builder) -> axum::http::request::Builder {\n        builder.header("authorization", format!("Bearer {TEST_TOKEN}"))\n    }\n\n    fn sample_event(id: &str, event_type: &str) -> MemoryEvent {`,
  'test auth helpers'
)
replaceOnce(
  `        let app = router(Arc::new(InMemoryRepository::default()));`,
  `        let app = router(Arc::new(InMemoryRepository::default()), test_auth());`,
  'first test router'
)
// There are two identical router lines; replace remaining one too.
source = source.replace(
  `        let app = router(Arc::new(InMemoryRepository::default()));`,
  `        let app = router(Arc::new(InMemoryRepository::default()), test_auth());`
)
source = source.replace(
  `                    Request::post("/v1/memory/events")\n                        .header("content-type", "application/json")`,
  `                    authorized(Request::post("/v1/memory/events"))\n                        .header("content-type", "application/json")`
)
source = source.replace(
  `                Request::get("/v1/projects/project-a/context")\n                    .body(Body::empty())`,
  `                authorized(Request::get("/v1/projects/project-a/context"))\n                    .body(Body::empty())`
)
replaceOnce(
  `    #[tokio::test]\n    async fn user_authority_boundary_is_fail_closed() {`,
  `    #[tokio::test]\n    async fn missing_bearer_token_is_rejected() {\n        let app = router(Arc::new(InMemoryRepository::default()), test_auth());\n        let event = sample_event("33333333-3333-4333-8333-333333333333", "decision.recorded");\n        let response = app\n            .oneshot(\n                Request::post("/v1/memory/events")\n                    .header("content-type", "application/json")\n                    .body(Body::from(serde_json::to_vec(&event).unwrap()))\n                    .unwrap(),\n            )\n            .await\n            .unwrap();\n        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);\n    }\n\n    #[tokio::test]\n    async fn user_authority_boundary_is_fail_closed() {`,
  'unauthenticated test'
)

fs.writeFileSync(libFile, source)

const mainFile = 'apps/memory-server/src/main.rs'
let main = fs.readFileSync(mainFile, 'utf8')
function replaceMain(from, to, label) {
  if (main.includes(to)) return
  if (!main.includes(from)) throw new Error(`memory server auth main patch drift: ${label}`)
  main = main.replace(from, to)
}
replaceMain(
  `use zero3_memory_server::{router, MemoryRepository, PostgresRepository};`,
  `use zero3_memory_server::{router, AuthPolicy, MemoryRepository, PostgresRepository};`,
  'auth import'
)
replaceMain(
  `    let database_url = std::env::var("ZERO3_MEMORY_DATABASE_URL")\n        .context("ZERO3_MEMORY_DATABASE_URL is required")?;`,
  `    let database_url = std::env::var("ZERO3_MEMORY_DATABASE_URL")\n        .context("ZERO3_MEMORY_DATABASE_URL is required")?;\n    let auth_json = std::env::var("ZERO3_MEMORY_AUTH_JSON")\n        .context("ZERO3_MEMORY_AUTH_JSON is required")?;\n    let auth = AuthPolicy::from_json(&auth_json).context("load memory auth policy")?;`,
  'auth env'
)
replaceMain(
  `    axum::serve(listener, router(repo))`,
  `    axum::serve(listener, router(repo, auth))`,
  'router auth'
)
fs.writeFileSync(mainFile, main)
