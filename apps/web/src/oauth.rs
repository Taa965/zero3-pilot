use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Form, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const ACCESS_TOKEN_TTL_SECONDS: i64 = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS: i64 = 5 * 60;
const PENDING_AUTH_TTL_SECONDS: i64 = 10 * 60;
const WORKER_SCOPE: &str = "zero3.worker";
const OFFLINE_SCOPE: &str = "offline_access";
#[derive(Clone)]
pub struct OAuthServer {
    root: PathBuf,
    issuer: String,
    owner_secret_hash: [u8; 32],
    state: Arc<Mutex<OAuthState>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OAuthState {
    clients: BTreeMap<String, OAuthClient>,
    pending: BTreeMap<String, PendingAuthorization>,
    codes: BTreeMap<String, AuthorizationCodeRecord>,
    access_tokens: BTreeMap<String, AccessTokenRecord>,
    refresh_tokens: BTreeMap<String, RefreshTokenRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthClient {
    client_id: String,
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    created_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingAuthorization {
    request_id: String,
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: String,
    scope: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthorizationCodeRecord {
    code_hash: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    scope: String,
    expires_at: DateTime<Utc>,
    used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccessTokenRecord {
    token_hash: String,
    client_id: String,
    scope: String,
    expires_at: DateTime<Utc>,
    revoked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RefreshTokenRecord {
    token_hash: String,
    client_id: String,
    scope: String,
    expires_at: DateTime<Utc>,
    revoked: bool,
}

#[derive(Debug, Deserialize)]
struct ClientRegistrationRequest {
    redirect_uris: Vec<String>,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    grant_types: Vec<String>,
    #[serde(default)]
    response_types: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthorizeQuery {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    resource: Option<String>,
}
#[derive(Debug, Deserialize)]
struct AuthorizeForm {
    request_id: String,
    owner_secret: String,
}

#[derive(Debug, Deserialize)]
struct TokenRequest {
    grant_type: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    code_verifier: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RevokeRequest {
    token: String,
    #[serde(default)]
    client_id: Option<String>,
}

#[derive(Debug)]
struct OAuthError {
    status: StatusCode,
    code: &'static str,
    description: String,
}
impl OAuthError {
    fn invalid_request(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            description: description.into(),
        }
    }

    fn invalid_client(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "invalid_client",
            description: description.into(),
        }
    }

    fn invalid_grant(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_grant",
            description: description.into(),
        }
    }

    fn invalid_scope(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_scope",
            description: description.into(),
        }
    }

    fn server(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "server_error",
            description: error.to_string(),
        }
    }
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":self.code,"error_description":self.description})),
        )
            .into_response()
    }
}
impl OAuthServer {
    pub fn open(root: PathBuf, issuer: String, owner_secret: &str) -> anyhow::Result<Self> {
        if !issuer.starts_with("https://") || issuer.ends_with('/') {
            anyhow::bail!(
                "ZERO3_WORKER_OAUTH_ISSUER must be an https origin without trailing slash"
            );
        }
        if owner_secret.len() < 32 {
            anyhow::bail!("OAuth owner secret must contain at least 32 characters");
        }
        fs::create_dir_all(&root)?;
        let state_path = root.join("state.json");
        let state = if state_path.exists() {
            serde_json::from_slice(&fs::read(&state_path)?)?
        } else {
            OAuthState::default()
        };
        Ok(Self {
            root,
            issuer,
            owner_secret_hash: sha256(owner_secret.as_bytes()),
            state: Arc::new(Mutex::new(state)),
        })
    }

    pub fn protected_resource_url(&self) -> String {
        format!("{}/.well-known/oauth-protected-resource/mcp", self.issuer)
    }

    pub fn validate_access_token(&self, token: &str, required_scope: &str) -> bool {
        let hash = sha256_hex(token.as_bytes());
        let mut state = self.state.lock().unwrap();
        cleanup_state(&mut state);
        state.access_tokens.get(&hash).is_some_and(|record| {
            !record.revoked
                && record.expires_at > Utc::now()
                && scope_contains(&record.scope, required_scope)
        })
    }
    fn protected_resource_metadata(&self) -> Value {
        json!({
            "resource": format!("{}/mcp", self.issuer),
            "authorization_servers": [self.issuer],
            "scopes_supported": [WORKER_SCOPE, OFFLINE_SCOPE],
            "bearer_methods_supported": ["header"]
        })
    }

    fn authorization_server_metadata(&self) -> Value {
        json!({
            "issuer": self.issuer,
            "authorization_endpoint": format!("{}/authorize", self.issuer),
            "token_endpoint": format!("{}/token", self.issuer),
            "registration_endpoint": format!("{}/oauth/register", self.issuer),
            "revocation_endpoint": format!("{}/revoke", self.issuer),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": [WORKER_SCOPE, OFFLINE_SCOPE]
        })
    }

    fn register_client(&self, input: ClientRegistrationRequest) -> Result<Value, OAuthError> {
        if input.redirect_uris.is_empty() || input.redirect_uris.len() > 16 {
            return Err(OAuthError::invalid_request(
                "redirect_uris must contain 1..16 entries",
            ));
        }
        for uri in &input.redirect_uris {
            validate_redirect_uri(uri)?;
        }
        if input
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|value| value != "none")
        {
            return Err(OAuthError::invalid_request(
                "only public PKCE clients are supported",
            ));
        }
        if !input.grant_types.is_empty()
            && !input
                .grant_types
                .iter()
                .all(|value| value == "authorization_code" || value == "refresh_token")
        {
            return Err(OAuthError::invalid_request("unsupported grant_types"));
        }
        if !input.response_types.is_empty()
            && input.response_types.iter().any(|value| value != "code")
        {
            return Err(OAuthError::invalid_request("unsupported response_types"));
        }
        let client_id = format!("z3c-{}", Uuid::new_v4().simple());
        let now = Utc::now();
        let client = OAuthClient {
            client_id: client_id.clone(),
            client_name: input.client_name.clone(),
            redirect_uris: input.redirect_uris.clone(),
            created_at: now,
        };
        let mut state = self.state.lock().unwrap();
        state.clients.insert(client_id.clone(), client);
        self.persist(&state).map_err(OAuthError::server)?;
        Ok(json!({
            "client_id": client_id,
            "client_id_issued_at": now.timestamp(),
            "client_name": input.client_name,
            "redirect_uris": input.redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"]
        }))
    }

    fn begin_authorization(&self, query: AuthorizeQuery) -> Result<String, OAuthError> {
        if query.response_type != "code" {
            return Err(OAuthError::invalid_request("response_type must be code"));
        }
        if query.code_challenge_method != "S256"
            || query.code_challenge.len() < 43
            || query.code_challenge.len() > 128
        {
            return Err(OAuthError::invalid_request("S256 PKCE is required"));
        }
        let scope = normalize_scope(query.scope.as_deref())?;
        if query
            .resource
            .as_deref()
            .is_some_and(|resource| resource != format!("{}/mcp", self.issuer))
        {
            return Err(OAuthError::invalid_request(
                "resource does not match Zero3 MCP",
            ));
        }
        let mut state = self.state.lock().unwrap();
        cleanup_state(&mut state);
        let client = state
            .clients
            .get(&query.client_id)
            .ok_or_else(|| OAuthError::invalid_client("unknown client_id"))?;
        if !client
            .redirect_uris
            .iter()
            .any(|uri| uri == &query.redirect_uri)
        {
            return Err(OAuthError::invalid_request(
                "redirect_uri is not registered",
            ));
        }
        let request_id = format!("z3auth-{}", Uuid::new_v4().simple());
        state.pending.insert(
            request_id.clone(),
            PendingAuthorization {
                request_id: request_id.clone(),
                client_id: query.client_id,
                redirect_uri: query.redirect_uri,
                state: query.state,
                code_challenge: query.code_challenge,
                scope,
                expires_at: Utc::now() + Duration::seconds(PENDING_AUTH_TTL_SECONDS),
            },
        );
        self.persist(&state).map_err(OAuthError::server)?;
        Ok(request_id)
    }

    fn approve_authorization(
        &self,
        request_id: &str,
        owner_secret: &str,
    ) -> Result<String, OAuthError> {
        if !constant_time_eq(&sha256(owner_secret.as_bytes()), &self.owner_secret_hash) {
            return Err(OAuthError::invalid_client("owner authorization failed"));
        }
        let mut state = self.state.lock().unwrap();
        cleanup_state(&mut state);
        let pending = state
            .pending
            .remove(request_id)
            .ok_or_else(|| OAuthError::invalid_grant("authorization request expired or invalid"))?;
        let code = random_token("z3ac");
        let code_hash = sha256_hex(code.as_bytes());
        state.codes.insert(
            code_hash.clone(),
            AuthorizationCodeRecord {
                code_hash,
                client_id: pending.client_id,
                redirect_uri: pending.redirect_uri.clone(),
                code_challenge: pending.code_challenge,
                scope: pending.scope,
                expires_at: Utc::now() + Duration::seconds(AUTH_CODE_TTL_SECONDS),
                used: false,
            },
        );
        self.persist(&state).map_err(OAuthError::server)?;
        Ok(redirect_with_code(
            &pending.redirect_uri,
            &code,
            pending.state.as_deref(),
        ))
    }
    fn exchange_token(&self, input: TokenRequest) -> Result<Value, OAuthError> {
        match input.grant_type.as_str() {
            "authorization_code" => self.exchange_authorization_code(input),
            "refresh_token" => self.exchange_refresh_token(input),
            _ => Err(OAuthError::invalid_request("unsupported grant_type")),
        }
    }

    fn exchange_authorization_code(&self, input: TokenRequest) -> Result<Value, OAuthError> {
        let code = input
            .code
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_request("code is required"))?;
        let client_id = input
            .client_id
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_client("client_id is required"))?;
        let redirect_uri = input
            .redirect_uri
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_request("redirect_uri is required"))?;
        let verifier = input
            .code_verifier
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_request("code_verifier is required"))?;
        if verifier.len() < 43 || verifier.len() > 128 {
            return Err(OAuthError::invalid_grant("code_verifier length is invalid"));
        }
        let code_hash = sha256_hex(code.as_bytes());
        let mut state = self.state.lock().unwrap();
        cleanup_state(&mut state);
        let record = state
            .codes
            .get_mut(&code_hash)
            .ok_or_else(|| OAuthError::invalid_grant("authorization code is invalid or expired"))?;
        if record.used
            || record.expires_at <= Utc::now()
            || record.client_id != client_id
            || record.redirect_uri != redirect_uri
        {
            return Err(OAuthError::invalid_grant(
                "authorization code cannot be used",
            ));
        }
        if pkce_challenge(verifier) != record.code_challenge {
            return Err(OAuthError::invalid_grant("PKCE verification failed"));
        }
        record.used = true;
        let scope = record.scope.clone();
        let response = issue_tokens(&mut state, client_id, &scope);
        self.persist(&state).map_err(OAuthError::server)?;
        Ok(response)
    }
    fn exchange_refresh_token(&self, input: TokenRequest) -> Result<Value, OAuthError> {
        let token = input
            .refresh_token
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_request("refresh_token is required"))?;
        let client_id = input
            .client_id
            .as_deref()
            .ok_or_else(|| OAuthError::invalid_client("client_id is required"))?;
        let token_hash = sha256_hex(token.as_bytes());
        let mut state = self.state.lock().unwrap();
        cleanup_state(&mut state);
        let record = state
            .refresh_tokens
            .get_mut(&token_hash)
            .ok_or_else(|| OAuthError::invalid_grant("refresh token is invalid or expired"))?;
        if record.revoked || record.expires_at <= Utc::now() || record.client_id != client_id {
            return Err(OAuthError::invalid_grant("refresh token cannot be used"));
        }
        let scope = record.scope.clone();
        record.revoked = true;
        let response = issue_tokens(&mut state, client_id, &scope);
        self.persist(&state).map_err(OAuthError::server)?;
        Ok(response)
    }

    fn revoke(&self, input: RevokeRequest) -> Result<(), OAuthError> {
        let hash = sha256_hex(input.token.as_bytes());
        let mut state = self.state.lock().unwrap();
        if let Some(record) = state.access_tokens.get_mut(&hash) {
            if input
                .client_id
                .as_deref()
                .is_none_or(|client_id| client_id == record.client_id)
            {
                record.revoked = true;
            }
        }
        if let Some(record) = state.refresh_tokens.get_mut(&hash) {
            if input
                .client_id
                .as_deref()
                .is_none_or(|client_id| client_id == record.client_id)
            {
                record.revoked = true;
            }
        }
        self.persist(&state).map_err(OAuthError::server)
    }

    fn persist(&self, state: &OAuthState) -> anyhow::Result<()> {
        write_json_atomic(&self.root.join("state.json"), state)
    }
}
#[derive(Clone)]
struct OAuthRouteState {
    server: Option<Arc<OAuthServer>>,
}

pub fn router(server: Option<Arc<OAuthServer>>) -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_metadata),
        )
        .route("/oauth/register", post(register_client))
        .route("/authorize", get(authorize_get).post(authorize_post))
        .route("/token", post(token))
        .route("/revoke", post(revoke))
        .with_state(OAuthRouteState { server })
}

fn require_server(state: &OAuthRouteState) -> Result<Arc<OAuthServer>, OAuthError> {
    state.server.clone().ok_or_else(|| OAuthError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        description: "Zero3 Worker OAuth is disabled".into(),
    })
}

async fn protected_resource(
    State(state): State<OAuthRouteState>,
) -> Result<Json<Value>, OAuthError> {
    Ok(Json(require_server(&state)?.protected_resource_metadata()))
}

async fn authorization_metadata(
    State(state): State<OAuthRouteState>,
) -> Result<Json<Value>, OAuthError> {
    Ok(Json(
        require_server(&state)?.authorization_server_metadata(),
    ))
}
async fn register_client(
    State(state): State<OAuthRouteState>,
    Json(input): Json<ClientRegistrationRequest>,
) -> Result<Json<Value>, OAuthError> {
    Ok(Json(require_server(&state)?.register_client(input)?))
}

async fn authorize_get(
    State(state): State<OAuthRouteState>,
    Query(query): Query<AuthorizeQuery>,
) -> Result<Html<String>, OAuthError> {
    let server = require_server(&state)?;
    let request_id = server.begin_authorization(query)?;
    Ok(Html(authorize_page(&request_id)))
}

async fn authorize_post(
    State(state): State<OAuthRouteState>,
    Form(input): Form<AuthorizeForm>,
) -> Result<Redirect, OAuthError> {
    let location =
        require_server(&state)?.approve_authorization(&input.request_id, &input.owner_secret)?;
    Ok(Redirect::to(&location))
}

async fn token(
    State(state): State<OAuthRouteState>,
    Form(input): Form<TokenRequest>,
) -> Result<Response, OAuthError> {
    let result = require_server(&state)?.exchange_token(input)?;
    let mut response = Json(result).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    Ok(response)
}

async fn revoke(
    State(state): State<OAuthRouteState>,
    Form(input): Form<RevokeRequest>,
) -> Result<StatusCode, OAuthError> {
    require_server(&state)?.revoke(input)?;
    Ok(StatusCode::OK)
}
fn issue_tokens(state: &mut OAuthState, client_id: &str, scope: &str) -> Value {
    let now = Utc::now();
    let access_token = random_token("z3at");
    let access_hash = sha256_hex(access_token.as_bytes());
    state.access_tokens.insert(
        access_hash.clone(),
        AccessTokenRecord {
            token_hash: access_hash,
            client_id: client_id.to_string(),
            scope: scope.to_string(),
            expires_at: now + Duration::seconds(ACCESS_TOKEN_TTL_SECONDS),
            revoked: false,
        },
    );
    let refresh_token = if scope_contains(scope, OFFLINE_SCOPE) {
        let token = random_token("z3rt");
        let hash = sha256_hex(token.as_bytes());
        state.refresh_tokens.insert(
            hash.clone(),
            RefreshTokenRecord {
                token_hash: hash,
                client_id: client_id.to_string(),
                scope: scope.to_string(),
                expires_at: now + Duration::seconds(REFRESH_TOKEN_TTL_SECONDS),
                revoked: false,
            },
        );
        Some(token)
    } else {
        None
    };
    let mut response = json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "scope": scope
    });
    if let Some(token) = refresh_token {
        response
            .as_object_mut()
            .unwrap()
            .insert("refresh_token".into(), Value::String(token));
    }
    response
}
fn normalize_scope(value: Option<&str>) -> Result<String, OAuthError> {
    let raw = value.unwrap_or(WORKER_SCOPE).trim();
    if raw.is_empty() {
        return Ok(WORKER_SCOPE.to_string());
    }
    let mut scopes = Vec::new();
    for scope in raw.split_ascii_whitespace() {
        if scope != WORKER_SCOPE && scope != OFFLINE_SCOPE {
            return Err(OAuthError::invalid_scope(format!(
                "unsupported scope: {scope}"
            )));
        }
        if !scopes.iter().any(|existing| existing == scope) {
            scopes.push(scope.to_string());
        }
    }
    if !scopes.iter().any(|scope| scope == WORKER_SCOPE) {
        scopes.insert(0, WORKER_SCOPE.to_string());
    }
    Ok(scopes.join(" "))
}

fn scope_contains(scope: &str, expected: &str) -> bool {
    scope
        .split_ascii_whitespace()
        .any(|value| value == expected)
}

fn validate_redirect_uri(uri: &str) -> Result<(), OAuthError> {
    if uri.len() > 4096 || !uri.starts_with("https://") || uri.contains('#') || uri.contains('@') {
        return Err(OAuthError::invalid_request(
            "redirect_uri must be an https URL without userinfo or fragment",
        ));
    }
    let authority = uri
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("");
    if authority.is_empty() || authority.starts_with('.') || authority.ends_with('.') {
        return Err(OAuthError::invalid_request("redirect_uri host is invalid"));
    }
    Ok(())
}
fn random_token(prefix: &str) -> String {
    format!(
        "{prefix}-{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn sha256(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = sha256(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha256(verifier.as_bytes()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn redirect_with_code(redirect_uri: &str, code: &str, state: Option<&str>) -> String {
    let separator = if redirect_uri.contains('?') { '&' } else { '?' };
    let mut location = format!(
        "{redirect_uri}{separator}code={}",
        urlencoding::encode(code)
    );
    if let Some(state) = state {
        location.push_str("&state=");
        location.push_str(&urlencoding::encode(state));
    }
    location
}
fn cleanup_state(state: &mut OAuthState) {
    let now = Utc::now();
    state.pending.retain(|_, record| record.expires_at > now);
    state
        .codes
        .retain(|_, record| record.expires_at > now && !record.used);
    state
        .access_tokens
        .retain(|_, record| record.expires_at > now);
    state
        .refresh_tokens
        .retain(|_, record| record.expires_at > now);
}

fn authorize_page(request_id: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zero3 Pilot 授权</title><style>
body{{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;margin:0;padding:48px}}
main{{max-width:520px;margin:auto;background:white;padding:32px;border-radius:20px;box-shadow:0 8px 32px #0001}}
h1{{margin-top:0}} input{{box-sizing:border-box;width:100%;padding:12px;margin:12px 0;border:1px solid #ccc;border-radius:10px}}
button{{width:100%;padding:12px;border:0;border-radius:10px;background:#111;color:white;font-weight:600}}
p{{color:#555;line-height:1.6}}</style></head><body><main>
<h1>授权 ChatGPT 访问 Zero3</h1><p>该授权仅允许 Zero3 Worker MCP 工具。请输入服务器上的 OAuth Owner Secret 继续。</p>
<form method="post" action="/authorize"><input type="hidden" name="request_id" value="{request_id}">
<label>Owner Secret</label><input type="password" name="owner_secret" autocomplete="current-password" required minlength="32">
<button type="submit">授权 Zero3 Pilot Worker</button></form></main></body></html>"#
    )
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const OWNER: &str = "zero3-oauth-owner-secret-for-tests-0123456789abcdef";
    const REDIRECT: &str = "https://chatgpt.com/aip/oauth/callback";

    fn server() -> (tempfile::TempDir, OAuthServer) {
        let dir = tempdir().unwrap();
        let server = OAuthServer::open(
            dir.path().join("oauth"),
            "https://pilot.03.336r.com".into(),
            OWNER,
        )
        .unwrap();
        (dir, server)
    }

    fn register(server: &OAuthServer) -> String {
        server
            .register_client(ClientRegistrationRequest {
                redirect_uris: vec![REDIRECT.into()],
                client_name: Some("ChatGPT".into()),
                token_endpoint_auth_method: Some("none".into()),
                grant_types: vec!["authorization_code".into(), "refresh_token".into()],
                response_types: vec!["code".into()],
            })
            .unwrap()["client_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn metadata_advertises_pkce_refresh_and_offline_access() {
        let (_dir, server) = server();
        let auth = server.authorization_server_metadata();
        assert_eq!(
            auth["authorization_endpoint"],
            "https://pilot.03.336r.com/authorize"
        );
        assert_eq!(auth["token_endpoint"], "https://pilot.03.336r.com/token");
        assert!(auth["scopes_supported"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == OFFLINE_SCOPE));
        assert!(auth["code_challenge_methods_supported"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "S256"));
        let resource = server.protected_resource_metadata();
        assert_eq!(resource["resource"], "https://pilot.03.336r.com/mcp");
    }

    #[test]
    fn authorization_code_pkce_refresh_rotation_and_revoke_work() {
        let (_dir, server) = server();
        let client_id = register(&server);
        let verifier = "a".repeat(64);
        let request_id = server
            .begin_authorization(AuthorizeQuery {
                response_type: "code".into(),
                client_id: client_id.clone(),
                redirect_uri: REDIRECT.into(),
                code_challenge: pkce_challenge(&verifier),
                code_challenge_method: "S256".into(),
                scope: Some(format!("{WORKER_SCOPE} {OFFLINE_SCOPE}")),
                state: Some("state-1".into()),
                resource: Some("https://pilot.03.336r.com/mcp".into()),
            })
            .unwrap();
        assert_eq!(
            server
                .approve_authorization(&request_id, "wrong-secret")
                .unwrap_err()
                .code,
            "invalid_client"
        );
        let redirect = server.approve_authorization(&request_id, OWNER).unwrap();
        let code = redirect
            .split("code=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        let token = server
            .exchange_token(TokenRequest {
                grant_type: "authorization_code".into(),
                code: Some(code.clone()),
                redirect_uri: Some(REDIRECT.into()),
                client_id: Some(client_id.clone()),
                code_verifier: Some(verifier.clone()),
                refresh_token: None,
            })
            .unwrap();
        let access = token["access_token"].as_str().unwrap().to_string();
        let refresh = token["refresh_token"].as_str().unwrap().to_string();
        assert!(server.validate_access_token(&access, WORKER_SCOPE));
        assert!(server
            .exchange_token(TokenRequest {
                grant_type: "authorization_code".into(),
                code: Some(code),
                redirect_uri: Some(REDIRECT.into()),
                client_id: Some(client_id.clone()),
                code_verifier: Some(verifier),
                refresh_token: None,
            })
            .is_err());
        let refreshed = server
            .exchange_token(TokenRequest {
                grant_type: "refresh_token".into(),
                code: None,
                redirect_uri: None,
                client_id: Some(client_id.clone()),
                code_verifier: None,
                refresh_token: Some(refresh.clone()),
            })
            .unwrap();
        assert!(server
            .exchange_token(TokenRequest {
                grant_type: "refresh_token".into(),
                code: None,
                redirect_uri: None,
                client_id: Some(client_id.clone()),
                code_verifier: None,
                refresh_token: Some(refresh),
            })
            .is_err());
        let access2 = refreshed["access_token"].as_str().unwrap().to_string();
        assert!(server.validate_access_token(&access2, WORKER_SCOPE));
        server
            .revoke(RevokeRequest {
                token: access2.clone(),
                client_id: Some(client_id),
            })
            .unwrap();
        assert!(!server.validate_access_token(&access2, WORKER_SCOPE));
    }

    #[test]
    fn pkce_failure_and_unregistered_redirect_fail_closed() {
        let (_dir, server) = server();
        let client_id = register(&server);
        assert!(server
            .begin_authorization(AuthorizeQuery {
                response_type: "code".into(),
                client_id: client_id.clone(),
                redirect_uri: "https://evil.example/callback".into(),
                code_challenge: pkce_challenge(&"b".repeat(64)),
                code_challenge_method: "S256".into(),
                scope: Some(WORKER_SCOPE.into()),
                state: None,
                resource: None,
            })
            .is_err());
        let verifier = "c".repeat(64);
        let request_id = server
            .begin_authorization(AuthorizeQuery {
                response_type: "code".into(),
                client_id: client_id.clone(),
                redirect_uri: REDIRECT.into(),
                code_challenge: pkce_challenge(&verifier),
                code_challenge_method: "S256".into(),
                scope: Some(WORKER_SCOPE.into()),
                state: None,
                resource: None,
            })
            .unwrap();
        let redirect = server.approve_authorization(&request_id, OWNER).unwrap();
        let code = redirect
            .split("code=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        let error = server
            .exchange_token(TokenRequest {
                grant_type: "authorization_code".into(),
                code: Some(code),
                redirect_uri: Some(REDIRECT.into()),
                client_id: Some(client_id),
                code_verifier: Some("d".repeat(64)),
                refresh_token: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid_grant");
    }

    #[test]
    fn persisted_state_contains_hashes_not_owner_or_access_token() {
        let (dir, server) = server();
        let client_id = register(&server);
        let response = {
            let mut state = server.state.lock().unwrap();
            let response = issue_tokens(
                &mut state,
                &client_id,
                &format!("{WORKER_SCOPE} {OFFLINE_SCOPE}"),
            );
            server.persist(&state).unwrap();
            response
        };
        let access = response["access_token"].as_str().unwrap().to_string();
        let raw = fs::read_to_string(dir.path().join("oauth/state.json")).unwrap();
        assert!(!raw.contains(OWNER));
        assert!(!raw.contains(&access));
        let reopened = OAuthServer::open(
            dir.path().join("oauth"),
            "https://pilot.03.336r.com".into(),
            OWNER,
        )
        .unwrap();
        assert!(reopened.validate_access_token(&access, WORKER_SCOPE));
    }
}
