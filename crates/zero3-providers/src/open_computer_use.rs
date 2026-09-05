//! Adapter for `iFurySt/open-codex-computer-use`.
//!
//! **Verified against upstream source, not assumed.** As of
//! `iFurySt/open-codex-computer-use@main` (checked via the GitHub API,
//! commit reachable from `main` at the time this was written):
//!
//! - Every platform runtime (`apps/OpenComputerUseWindows/main.go`,
//!   the Linux runtime, and the macOS
//!   `packages/OpenComputerUseKit/Sources/OpenComputerUseKit/MCPServer.swift`)
//!   is invoked as `<binary> mcp` and then speaks **standard MCP over
//!   stdio**: JSON-RPC 2.0 messages, one per line, `initialize` ->
//!   `notifications/initialized` -> `tools/list` / `tools/call`. This is
//!   *not* a custom line-delimited action/result protocol — an earlier
//!   version of this adapter assumed one and was wrong; this rewrite
//!   fixes that (see `plugins/open-computer-use/scripts/launch-open-computer-use.sh`,
//!   which execs `<binary> mcp`, and `apps/OpenComputerUseWindows/main.go`'s
//!   `runMCP`/`handleMCPRequest`, which decode/encode JSON-RPC on
//!   stdin/stdout with `json.NewDecoder`/`json.NewEncoder`).
//! - The real tool surface (`apps/OpenComputerUseWindows/main.go`'s
//!   `toolDefinitions()`) is `click`, `drag`, `get_app_state`,
//!   `list_apps`, `perform_secondary_action`, `press_key`, `scroll`,
//!   `set_value`, `type_text`. This adapter currently maps `list_apps`,
//!   `get_app_state`, `click`, `type_text`, and `press_key` behind the
//!   backend-agnostic `ComputerAction` contract.
//!
//! A JSON-RPC session is stateful (the `initialize` handshake happens
//! once), so unlike a stateless request/response adapter this one keeps a
//! **persistent child process** across calls, spawned lazily on first use
//! and torn down on `shutdown()` or `kill_on_drop` if the adapter itself
//! is dropped.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

use crate::computer::{ComputerAction, ComputerActionResult, ComputerProvider};
use crate::provider::Provider;

const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const DEFAULT_SNAPSHOT_MAX_TREE_NODES: usize = 200;
const DEFAULT_SNAPSHOT_MAX_TREE_DEPTH: usize = 16;
const DEFAULT_SNAPSHOT_TEXT_LIMIT: usize = 4_000;

/// How long `shutdown()` waits for the child to exit on its own after
/// closing stdin before force-killing it. Deliberately short and
/// independent of `call_timeout` (which governs RPC round-trips, not
/// process teardown) — closing a pipe's write end doesn't reliably
/// deliver a fast EOF-driven exit on every platform (observed: a child
/// that exits in ~200ms given the same EOF over a plain shell pipe can
/// take tokio's Windows `Child::wait()` the full RPC timeout to notice),
/// so shutdown falls back to an explicit `kill()` well before that.
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(1);

struct McpSession {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

pub struct OpenComputerUseAdapter {
    executable: PathBuf,
    call_timeout: Duration,
    session: AsyncMutex<Option<McpSession>>,
    next_id: AtomicI64,
}

impl OpenComputerUseAdapter {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            call_timeout: Duration::from_secs(10),
            session: AsyncMutex::new(None),
            next_id: AtomicI64::new(1),
        }
    }

    pub fn with_timeout(mut self, call_timeout: Duration) -> Self {
        self.call_timeout = call_timeout;
        self
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let mut guard = self.session.lock().await;
        if let Some(mut session) = guard.take() {
            let _ = session.stdin.shutdown().await;
            if timeout(SHUTDOWN_GRACE_PERIOD, session.child.wait())
                .await
                .is_err()
            {
                let _ = session.child.kill().await;
                let _ = session.child.wait().await;
            }
        }
        Ok(())
    }

    fn next_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    async fn write_message(stdin: &mut ChildStdin, value: &Value) -> anyhow::Result<()> {
        let mut line = serde_json::to_string(value)?;
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn read_message(reader: &mut BufReader<ChildStdout>) -> anyhow::Result<Value> {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            anyhow::bail!("open-computer-use adapter closed stdout (process exited)");
        }
        Ok(serde_json::from_str(line.trim())?)
    }

    async fn ensure_session(&self, guard: &mut Option<McpSession>) -> anyhow::Result<()> {
        if guard.is_some() {
            return Ok(());
        }

        let mut child = Command::new(&self.executable)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                anyhow::anyhow!(
                    "failed to spawn open-computer-use adapter at {:?}: {e}",
                    self.executable
                )
            })?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let mut session = McpSession {
            child,
            stdin,
            reader: BufReader::new(stdout),
        };

        let handshake = async {
            let init_id = self.next_id();
            let request = json!({
                "jsonrpc": "2.0",
                "id": init_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "zero3-pilot", "version": env!("CARGO_PKG_VERSION") },
                },
            });
            Self::write_message(&mut session.stdin, &request).await?;
            let response = Self::read_message(&mut session.reader).await?;
            if let Some(error) = response.get("error") {
                anyhow::bail!("open-computer-use adapter rejected initialize: {error}");
            }

            let notification = json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            });
            Self::write_message(&mut session.stdin, &notification).await?;
            Ok::<McpSession, anyhow::Error>(session)
        };

        let session = timeout(self.call_timeout, handshake).await.map_err(|_| {
            anyhow::anyhow!(
                "open-computer-use adapter timed out after {:?} during MCP handshake",
                self.call_timeout
            )
        })??;

        *guard = Some(session);
        Ok(())
    }

    async fn rpc_call(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let mut guard = self.session.lock().await;

        let result = async {
            self.ensure_session(&mut guard).await?;
            let session = guard.as_mut().expect("ensure_session established one");

            let id = self.next_id();
            let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });

            let call = async {
                Self::write_message(&mut session.stdin, &request).await?;
                loop {
                    let message = Self::read_message(&mut session.reader).await?;
                    if message.get("id").and_then(Value::as_i64) == Some(id) {
                        return Ok::<Value, anyhow::Error>(message);
                    }
                }
            };

            timeout(self.call_timeout, call).await.map_err(|_| {
                anyhow::anyhow!(
                    "open-computer-use adapter timed out after {:?} waiting for '{method}'",
                    self.call_timeout
                )
            })?
        }
        .await;

        let response = match result {
            Ok(response) => response,
            Err(e) => {
                *guard = None;
                return Err(e);
            }
        };

        if let Some(error) = response.get("error") {
            anyhow::bail!(
                "open-computer-use adapter returned a JSON-RPC error for '{method}': {error}"
            );
        }
        response.get("result").cloned().ok_or_else(|| {
            anyhow::anyhow!(
                "open-computer-use adapter response for '{method}' had neither result nor error"
            )
        })
    }

    pub async fn list_remote_tools(&self) -> anyhow::Result<Vec<String>> {
        let result = self.rpc_call("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(tools
            .into_iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
            .collect())
    }

    async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
    ) -> anyhow::Result<ComputerActionResult> {
        let result = self
            .rpc_call(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await?;
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(ComputerActionResult {
            ok: !is_error,
            detail: result,
        })
    }
}

#[async_trait]
impl Provider for OpenComputerUseAdapter {
    fn name(&self) -> &str {
        "open-computer-use"
    }

    fn capabilities(&self) -> Vec<String> {
        vec![
            "list_apps".into(),
            "get_app_state".into(),
            "click".into(),
            "type_text".into(),
            "press_key".into(),
        ]
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        let tools = self.list_remote_tools().await?;
        if tools.is_empty() {
            anyhow::bail!("open-computer-use reported zero tools");
        }
        Ok(())
    }
}

#[async_trait]
impl ComputerProvider for OpenComputerUseAdapter {
    async fn execute(&self, action: ComputerAction) -> anyhow::Result<ComputerActionResult> {
        let (name, arguments) = match action {
            ComputerAction::ListApps => ("list_apps", json!({})),
            ComputerAction::Screenshot { app } => (
                "get_app_state",
                json!({
                    "app": app,
                    "max_tree_nodes": DEFAULT_SNAPSHOT_MAX_TREE_NODES,
                    "max_tree_depth": DEFAULT_SNAPSHOT_MAX_TREE_DEPTH,
                    "text_limit": DEFAULT_SNAPSHOT_TEXT_LIMIT
                }),
            ),
            ComputerAction::Click { app, x, y } => ("click", json!({ "app": app, "x": x, "y": y })),
            ComputerAction::Type { app, text } => {
                ("type_text", json!({ "app": app, "text": text }))
            }
            ComputerAction::KeyPress { app, key } => {
                ("press_key", json!({ "app": app, "key": key }))
            }
        };
        self.call_tool(name, arguments).await
    }
}
