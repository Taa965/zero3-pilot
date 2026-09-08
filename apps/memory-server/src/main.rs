use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use zero3_memory_server::{router, PostgresRepository};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("ZERO3_MEMORY_DATABASE_URL").context("ZERO3_MEMORY_DATABASE_URL is required")?;
    let bind: SocketAddr = std::env::var("ZERO3_MEMORY_BIND").unwrap_or_else(|_| "127.0.0.1:8790".into()).parse().context("parse ZERO3_MEMORY_BIND")?;
    let repo = Arc::new(PostgresRepository::new(database_url));
    repo.ready().await.context("memory database is not ready")?;

    let listener = tokio::net::TcpListener::bind(bind).await.context("bind memory server")?;
    tracing::info!(%bind, "Zero3 Memory Authority V2.1 listening");
    axum::serve(listener, router(repo)).with_graceful_shutdown(shutdown_signal()).await.context("serve memory authority")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("install Ctrl+C handler") };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("install SIGTERM handler").recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
