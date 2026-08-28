//! Zero3 Pilot control/web server (Phase 1: health endpoint only).
//!
//! This is the surface GitHub Actions deploy verification hits after a
//! release: `GET /health` must return 200 with `{"status":"ok",...}`.
//! No secrets are ever included in the response.

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

const GIT_SHA: &str = env!("ZERO3_GIT_SHA");
const VERSION: &str = env!("CARGO_PKG_VERSION");

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "git_sha": GIT_SHA,
    }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = Router::new().route("/health", get(health));

    let port: u16 = std::env::var("ZERO3_WEB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

    println!("zero3-web listening on http://{addr} (git_sha={GIT_SHA})");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        let app = Router::new().route("/health", get(health));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
