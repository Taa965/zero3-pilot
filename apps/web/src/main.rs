//! Zero3 Pilot control/web server.
//!
//! `/health` remains the deployment verification surface. Remote Host control
//! endpoints are mounted only with host/control token files configured; when
//! they are absent the health surface still starts, while remote endpoints
//! fail closed with 503.

mod control_admission;
mod control_extensions;
mod control_plane;

use axum::extract::DefaultBodyLimit;
use axum::{middleware, routing::get, Json, Router};
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

fn app(
    remote_control: control_plane::RemoteControlRuntime,
    task_extensions: control_extensions::TaskExtensionRuntime,
) -> Router {
    let remote = control_plane::router(remote_control)
        .merge(control_extensions::router(task_extensions))
        .layer(DefaultBodyLimit::max(
            control_admission::MAX_REMOTE_CONTROL_BODY_BYTES,
        ))
        .layer(middleware::from_fn(
            control_admission::validate_control_task_admission,
        ));

    Router::new().route("/health", get(health)).merge(remote)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let remote_control = control_plane::RemoteControlRuntime::from_env()?;
    let task_extensions = control_extensions::TaskExtensionRuntime::from_env()?;
    let app = app(remote_control, task_extensions);

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
    async fn health_returns_ok_even_when_remote_control_is_disabled() {
        let remote_control = control_plane::RemoteControlRuntime::from_env().unwrap();
        let task_extensions = control_extensions::TaskExtensionRuntime::from_env().unwrap();
        let response = app(remote_control, task_extensions)
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
