//! Real one-shot workers for Codex, Claude Code, and Hermes.
//!
//! Zero3 Pilot does not embed or duplicate any of those agents' runtimes. Each
//! worker is a thin, bounded process adapter over the tool's supported
//! non-interactive entry point. The common adapter owns timeout, cwd, env,
//! exit-code handling, stdout/stderr capture, and the transport-safe result.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use zero3_core::subagent::{SubagentResult, SubagentTask, SubagentWorker};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_PROMPT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliWorkerConfig {
    pub executable: PathBuf,
    #[serde(default)]
    pub extra_args: Vec<String>,
    pub working_dir: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub timeout_ms: u64,
}

impl CliWorkerConfig {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            extra_args: Vec::new(),
            working_dir: None,
            env: BTreeMap::new(),
            timeout_ms: DEFAULT_TIMEOUT.as_millis() as u64,
        }
    }

    pub fn with_working_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(path.into());
        self
    }

    pub fn with_extra_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.extra_args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout_ms = timeout.as_millis().max(1) as u64;
        self
    }
}

#[derive(Debug, Clone, Copy)]
enum CliKind {
    Codex,
    Claude,
    Hermes,
}

impl CliKind {
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Hermes => "hermes",
        }
    }

    fn base_args(self) -> &'static [&'static str] {
        match self {
            // Current Codex supports non-interactive execution with JSONL events.
            Self::Codex => &["exec", "--json"],
            // Claude Code's documented one-shot/automation mode.
            Self::Claude => &["-p", "--output-format", "json"],
            // Hermes' scripted one-shot mode: final response only.
            Self::Hermes => &["-z"],
        }
    }
}

#[derive(Debug, Clone)]
struct CliWorker {
    kind: CliKind,
    config: CliWorkerConfig,
}

impl CliWorker {
    fn new(kind: CliKind, config: CliWorkerConfig) -> Self {
        Self { kind, config }
    }

    async fn run(&self, task: SubagentTask) -> anyhow::Result<SubagentResult> {
        let prompt = render_prompt(&task)?;
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(anyhow!(
                "subagent prompt is {} bytes, over the {} byte limit",
                prompt.len(),
                MAX_PROMPT_BYTES
            ));
        }

        let mut command = Command::new(&self.config.executable);
        command
            .args(self.kind.base_args())
            .args(&self.config.extra_args)
            .arg(&prompt)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &self.config.working_dir {
            command.current_dir(cwd);
        }
        for (key, value) in &self.config.env {
            command.env(key, value);
        }
        // Avoid Codex entering its TERM=dumb non-interactive edge case while
        // still using no shell and a bounded process timeout.
        if matches!(self.kind, CliKind::Codex) {
            command.env("TERM", "xterm-256color");
        }

        let timeout = Duration::from_millis(self.config.timeout_ms.max(1));
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .map_err(|_| anyhow!("{} worker timed out after {timeout:?}", self.kind.name()))?
            .with_context(|| {
                format!(
                    "spawn {} worker executable {}",
                    self.kind.name(),
                    self.config.executable.display()
                )
            })?;

        let stdout = clip_bytes(output.stdout);
        let stderr = clip_bytes(output.stderr);
        if !output.status.success() {
            return Err(anyhow!(
                "{} worker exited with {}\nstderr:\n{}\nstdout:\n{}",
                self.kind.name(),
                output.status,
                stderr,
                stdout
            ));
        }

        Ok(parse_success(self.kind, stdout, stderr))
    }
}

fn render_prompt(task: &SubagentTask) -> anyhow::Result<String> {
    let context = serde_json::to_string_pretty(&task.context).context("serialize subagent context")?;
    Ok(format!(
        "Goal:\n{}\n\nZero3 Pilot task context (JSON):\n{}",
        task.goal, context
    ))
}

fn clip_bytes(bytes: Vec<u8>) -> String {
    let start = bytes.len().saturating_sub(MAX_CAPTURE_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn parse_success(kind: CliKind, stdout: String, stderr: String) -> SubagentResult {
    match kind {
        CliKind::Claude => {
            let parsed = serde_json::from_str::<Value>(stdout.trim()).ok();
            let summary = parsed
                .as_ref()
                .and_then(|value| value.get("result"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| stdout.trim().to_owned());
            SubagentResult {
                summary,
                output: json!({
                    "backend": "claude",
                    "response": parsed,
                    "stdout": stdout,
                    "stderr": stderr,
                }),
            }
        }
        CliKind::Hermes => SubagentResult {
            summary: stdout.trim().to_owned(),
            output: json!({
                "backend": "hermes",
                "stdout": stdout,
                "stderr": stderr,
            }),
        },
        CliKind::Codex => {
            let events = stdout
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>();
            let summary = events
                .iter()
                .rev()
                .find_map(agent_message_text)
                .unwrap_or_else(|| stdout.trim().to_owned());
            SubagentResult {
                summary,
                output: json!({
                    "backend": "codex",
                    "events": events,
                    "stdout": stdout,
                    "stderr": stderr,
                }),
            }
        }
    }
}

fn agent_message_text(value: &Value) -> Option<String> {
    if let Some(item) = value.get("item") {
        if item.get("type").and_then(Value::as_str) == Some("agent_message") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                return Some(text.to_owned());
            }
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("agent_message") {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            return Some(text.to_owned());
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct CodexWorker {
    inner: CliWorker,
}

impl CodexWorker {
    pub fn new(config: CliWorkerConfig) -> Self {
        Self {
            inner: CliWorker::new(CliKind::Codex, config),
        }
    }
}

impl Default for CodexWorker {
    fn default() -> Self {
        Self::new(CliWorkerConfig::new("codex"))
    }
}

#[async_trait]
impl SubagentWorker for CodexWorker {
    fn name(&self) -> &str {
        "codex"
    }

    async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult> {
        self.inner.run(task).await
    }
}

#[derive(Debug, Clone)]
pub struct ClaudeWorker {
    inner: CliWorker,
}

impl ClaudeWorker {
    pub fn new(config: CliWorkerConfig) -> Self {
        Self {
            inner: CliWorker::new(CliKind::Claude, config),
        }
    }
}

impl Default for ClaudeWorker {
    fn default() -> Self {
        Self::new(CliWorkerConfig::new("claude"))
    }
}

#[async_trait]
impl SubagentWorker for ClaudeWorker {
    fn name(&self) -> &str {
        "claude"
    }

    async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult> {
        self.inner.run(task).await
    }
}

#[derive(Debug, Clone)]
pub struct HermesWorker {
    inner: CliWorker,
}

impl HermesWorker {
    pub fn new(config: CliWorkerConfig) -> Self {
        Self {
            inner: CliWorker::new(CliKind::Hermes, config),
        }
    }
}

impl Default for HermesWorker {
    fn default() -> Self {
        Self::new(CliWorkerConfig::new("hermes"))
    }
}

#[async_trait]
impl SubagentWorker for HermesWorker {
    fn name(&self) -> &str {
        "hermes"
    }

    async fn dispatch(&self, task: SubagentTask) -> anyhow::Result<SubagentResult> {
        self.inner.run(task).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_worker_uses_the_documented_noninteractive_entrypoint() {
        assert_eq!(CliKind::Codex.base_args(), ["exec", "--json"]);
        assert_eq!(CliKind::Claude.base_args(), ["-p", "--output-format", "json"]);
        assert_eq!(CliKind::Hermes.base_args(), ["-z"]);
    }

    #[test]
    fn codex_jsonl_extracts_last_agent_message() {
        let output = parse_success(
            CliKind::Codex,
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n".into(),
            String::new(),
        );
        assert_eq!(output.summary, "done");
    }

    #[tokio::test]
    async fn missing_executable_fails_loudly() {
        let worker = HermesWorker::new(CliWorkerConfig::new(
            "zero3-pilot-this-executable-does-not-exist",
        ));
        let err = worker
            .dispatch(SubagentTask {
                goal: "hello".into(),
                context: json!({}),
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("spawn hermes worker"));
    }
}
