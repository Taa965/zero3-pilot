mod authorization;

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use authorization::{looks_like_code, validate_code, AuthorizationStore};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::sleep;
use zero3_providers::weixin_clawbot::{
    WeixinClawBotClient, WeixinConnectionStatus, WeixinLoginState, WeixinMessage,
};

const DEFAULT_NODE_URL: &str = "http://127.0.0.1:8790";
const COMMAND_PREFIX: &str = "/pilot";
const CANCEL_COMMAND: &str = "/cancel";
const APPROVAL_TTL: Duration = Duration::from_secs(120);
const AUTH_LOCKOUT: Duration = Duration::from_secs(600);
const MAX_AUTH_FAILURES: u8 = 5;

#[derive(Debug, Deserialize)]
struct AcceptedJob {
    job_id: String,
}

#[derive(Debug, Deserialize)]
struct JobRecord {
    status: String,
    output: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct RemoteCommand {
    backend: String,
    goal: String,
    from_user_id: String,
    session_id: Option<String>,
    message_id: Option<u64>,
    context_token: Option<String>,
}

#[derive(Debug)]
struct PendingApproval {
    command: RemoteCommand,
    created_at: Instant,
}

#[derive(Debug, Default)]
struct ApprovalSession {
    pending: Option<PendingApproval>,
    failed_attempts: u8,
    locked_until: Option<Instant>,
}

impl ApprovalSession {
    fn clear_pending(&mut self) {
        self.pending = None;
    }
    fn pending_expired(&mut self) -> bool {
        let expired = self
            .pending
            .as_ref()
            .map(|pending| pending.created_at.elapsed() >= APPROVAL_TTL)
            .unwrap_or(false);
        if expired {
            self.pending = None;
        }
        expired
    }

    fn lockout_remaining(&mut self) -> Option<Duration> {
        let until = self.locked_until?;
        let now = Instant::now();
        if now >= until {
            self.locked_until = None;
            self.failed_attempts = 0;
            None
        } else {
            Some(until.saturating_duration_since(now))
        }
    }

    fn register_failure(&mut self) -> bool {
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        if self.failed_attempts >= MAX_AUTH_FAILURES {
            self.failed_attempts = 0;
            self.locked_until = Some(Instant::now() + AUTH_LOCKOUT);
            true
        } else {
            false
        }
    }

    fn register_success(&mut self) {
        self.failed_attempts = 0;
        self.locked_until = None;
    }
}

enum SubmitOutcome {
    Accepted(AcceptedJob),
    Completed(Value),
    ApprovalRequired(String),
}

fn data_dir() -> PathBuf {
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

fn node_url() -> String {
    std::env::var("ZERO3_PILOT_NODE_URL")
        .unwrap_or_else(|_| DEFAULT_NODE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn default_backend() -> String {
    std::env::var("ZERO3_WEIXIN_AGENT").unwrap_or_else(|_| "zero3".to_string())
}

fn print_usage() {
    println!(
        "Zero3 Pilot Weixin ClawBot\n\n\
         Usage:\n  zero3-pilot-weixin status\n  zero3-pilot-weixin login\n  zero3-pilot-weixin run [zero3|codex|claude]\n  zero3-pilot-weixin notify [text]   (reads stdin when text is omitted)\n  zero3-pilot-weixin disconnect\n\n\
         Only messages from the WeChat account that scanned the QR code are accepted.\n\
         普通文本默认交给 Zero3；/pilot 可显式选择处理器。Examples:\n  /pilot summarize my current task\n  /pilot codex inspect the current project"
    );
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "help".to_string());
    let data_dir = data_dir();
    let state_path = data_dir.join("weixin-clawbot.json");
    let auth_path = data_dir.join("weixin-authorization.json");
    let weixin = WeixinClawBotClient::open(state_path)?;
    let mut authorization = AuthorizationStore::open(auth_path)?;

    match command.as_str() {
        "status" => {
            let status = weixin.status().await;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "weixin": status,
                    "authorization_configured": authorization.is_configured(),
                }))?
            );
        }
        "login" => login(&weixin, &mut authorization).await?,
        "notify" => notify(&weixin).await?,
        "run" => {
            if !authorization.is_configured() {
                return Err(anyhow!(
                    "尚未设置微信高风险操作授权码。请先运行 zero3-pilot-weixin login"
                ));
            }
            let backend = std::env::args().nth(2).unwrap_or_else(default_backend);
            validate_backend(&backend)?;
            run_bridge(&weixin, &authorization, &backend).await?;
        }
        "disconnect" => {
            weixin.disconnect().await?;
            authorization.clear()?;
            println!(
                "微信 ClawBot 本地绑定和高风险操作授权码已移除。需要再次使用时重新运行 login。"
            );
        }
        _ => print_usage(),
    }
    Ok(())
}

async fn login(
    weixin: &WeixinClawBotClient,
    authorization: &mut AuthorizationStore,
) -> anyhow::Result<()> {
    let current = weixin.status().await;
    if current.connected {
        println!("微信 ClawBot 已连接：{}", status_label(&current));
        ensure_authorization_code(authorization)?;
        println!("如需换绑，请先运行 zero3-pilot-weixin disconnect。");
        return Ok(());
    }

    let started = weixin.start_login().await?;
    println!("请用手机微信扫描并确认授权：\n{}", started.qrcode_url);
    let _ = open_qr_url(&started.qrcode_url);

    let mut verify_code: Option<String> = None;
    loop {
        let poll = weixin
            .poll_login(&started.session_key, verify_code.as_deref())
            .await?;
        verify_code = None;
        println!("{}", poll.message);
        match poll.state {
            WeixinLoginState::Waiting | WeixinLoginState::Scanned => {
                sleep(Duration::from_secs(1)).await;
            }
            WeixinLoginState::NeedVerifyCode => {
                print!("微信配对码: ");
                io::stdout().flush()?;
                let mut line = String::new();
                io::stdin().read_line(&mut line)?;
                verify_code = Some(line.trim().to_string());
            }
            WeixinLoginState::Connected | WeixinLoginState::AlreadyConnected => {
                ensure_authorization_code(authorization)?;
                println!("连接完成。现在可运行 zero3-pilot-weixin run。");
                if let Some(owner) = weixin.owner_user_id().await {
                    if let Err(error) = weixin
                        .send_text(
                            &owner,
                            "Zero3 Pilot 已完成微信绑定。高风险操作会单独要求发送授权码；验证通过只授权当前待执行操作。",
                            None,
                        )                        .await
                    {
                        eprintln!("发送微信绑定确认失败: {error:#}");
                    }
                }
                return Ok(());
            }
            WeixinLoginState::Expired | WeixinLoginState::VerifyCodeBlocked => {
                return Err(anyhow!(poll.message));
            }
        }
    }
}

fn ensure_authorization_code(authorization: &mut AuthorizationStore) -> anyhow::Result<()> {
    if authorization.is_configured() {
        return Ok(());
    }

    println!(
        "\n首次微信绑定需要设置 Zero3 高风险操作授权码。\n\
         以后微信触发高风险操作时，机器人会要求你发送此授权码后才执行。\n\
         授权码长度 6-64 个字符，不能包含空白；本机只保存加盐多轮 SHA-256 摘要。"
    );

    loop {
        print!("设置授权码: ");
        io::stdout().flush()?;
        let mut first = String::new();
        io::stdin()
            .read_line(&mut first)
            .context("读取微信授权码")?;
        let first = first.trim().to_string();
        if let Err(error) = validate_code(&first) {
            println!("{error}");
            continue;
        }

        print!("再次输入授权码: ");
        io::stdout().flush()?;
        let mut second = String::new();
        io::stdin()
            .read_line(&mut second)
            .context("再次读取微信授权码")?;
        let second = second.trim().to_string();
        if first != second {
            println!("两次授权码不一致，请重新设置。");
            continue;
        }

        authorization.configure(&first)?;
        println!("高风险操作授权码设置完成。");
        return Ok(());
    }
}

/// Pushes a one-off text to the bound owner, e.g. alerts relayed from ops
/// watchdogs. There is no inbound message to echo a context token from;
/// iLink accepts tokenless sends, same as the login confirmation above.
async fn notify(weixin: &WeixinClawBotClient) -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let raw = if args.is_empty() {
        io::read_to_string(io::stdin()).context("读取通知内容")?
    } else {
        args.join(" ")
    };
    let text = notify_text(&raw)?;
    let owner = weixin
        .owner_user_id()
        .await
        .ok_or_else(|| anyhow!("微信 ClawBot 尚未连接。先运行 zero3-pilot-weixin login"))?;
    weixin.send_text(&owner, &text, None).await
}

fn notify_text(raw: &str) -> anyhow::Result<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(anyhow!("通知内容不能为空"));
    }
    Ok(truncate_utf8(text, 3500))
}

async fn run_bridge(
    weixin: &WeixinClawBotClient,
    authorization: &AuthorizationStore,
    backend: &str,
) -> anyhow::Result<()> {
    let status = weixin.status().await;
    if !status.connected {
        return Err(anyhow!(
            "微信 ClawBot 尚未连接。先运行 zero3-pilot-weixin login"
        ));
    }
    ensure_router_healthy().await?;
    println!(
        "微信 ClawBot 已连接到 Zero3 Pilot。默认处理器={backend}。普通文本可直接发送，{COMMAND_PREFIX} 可显式选择处理器。"
    );
    let mut approval = ApprovalSession::default();

    loop {
        match weixin.get_updates().await {
            Ok(messages) => {
                for message in messages {
                    if let Err(error) =
                        handle_message(weixin, authorization, &mut approval, message, backend).await
                    {
                        eprintln!("处理微信消息失败: {error:#}");
                    }
                }
            }
            Err(error) => {
                eprintln!("微信长轮询失败: {error:#}; 3 秒后重试");
                sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

async fn handle_message(
    weixin: &WeixinClawBotClient,
    authorization: &AuthorizationStore,
    approval: &mut ApprovalSession,
    message: WeixinMessage,
    default_backend: &str,
) -> anyhow::Result<()> {
    let Some(from) = message.from_user_id.clone() else {
        return Ok(());
    };
    let owner = weixin.owner_user_id().await;
    if owner.as_deref() != Some(from.as_str()) {
        return Ok(());
    }
    let Some(text) = message.text() else {
        return Ok(());
    };
    let trimmed = text.trim();

    if approval.pending_expired() && looks_like_code(trimmed) {
        weixin
            .send_text(
                &from,
                "授权请求已超过 2 分钟并失效，请重新发送原 /pilot 指令。",
                message.context_token.as_deref(),
            )
            .await?;
        return Ok(());
    }

    if approval.pending.is_some() {
        if trimmed.eq_ignore_ascii_case(CANCEL_COMMAND) {
            approval.clear_pending();
            weixin
                .send_text(
                    &from,
                    "已取消当前待授权操作。",
                    message.context_token.as_deref(),
                )
                .await?;
            return Ok(());
        }

        if trimmed.starts_with(COMMAND_PREFIX) {
            weixin
                .send_text(
                    &from,
                    "当前已有待授权操作。请先发送授权码，或发送 /cancel 取消后再提交新指令。",
                    message.context_token.as_deref(),
                )
                .await?;
            return Ok(());
        }
        if let Some(remaining) = approval.lockout_remaining() {
            let minutes = (remaining.as_secs() + 59) / 60;
            weixin
                .send_text(
                    &from,
                    &format!("授权码尝试次数过多，已临时锁定。约 {minutes} 分钟后可重试。"),
                    message.context_token.as_deref(),
                )
                .await?;
            return Ok(());
        }

        if !looks_like_code(trimmed) {
            weixin
                .send_text(
                    &from,
                    "当前操作等待授权。请直接发送授权码，或发送 /cancel 取消。",
                    message.context_token.as_deref(),
                )
                .await?;
            return Ok(());
        }

        if authorization.verify(trimmed)? {
            approval.register_success();
            let pending = approval.pending.take().expect("pending approval exists");
            weixin
                .send_text(
                    &from,
                    "授权码验证通过，仅授权当前操作。正在执行。",
                    message.context_token.as_deref(),
                )
                .await?;
            execute_and_reply(weixin, pending.command, true).await?;
        } else {
            let locked = approval.register_failure();
            let reply = if locked {
                "授权码连续错误 5 次，已锁定 10 分钟；当前操作不会执行。".to_string()
            } else {
                let remaining = MAX_AUTH_FAILURES.saturating_sub(approval.failed_attempts);
                format!("授权码错误，当前操作未执行。还可尝试 {remaining} 次。")
            };
            weixin
                .send_text(&from, &reply, message.context_token.as_deref())
                .await?;
        }
        return Ok(());
    }

    let (backend, goal) = match parse_user_message(trimmed, default_backend) {
        Ok(value) => value,
        Err(error) => {
            weixin
                .send_text(&from, &error.to_string(), message.context_token.as_deref())
                .await?;
            return Ok(());
        }
    };
    let command = RemoteCommand {
        backend,
        goal: goal.to_string(),
        from_user_id: from.clone(),
        session_id: message.session_id.clone(),
        message_id: message.message_id,
        context_token: message.context_token.clone(),
    };
    let outcome = match submit_agent(&command, false).await {
        Ok(value) => value,
        Err(error) => {
            weixin
                .send_text(
                    &from,
                    &truncate_utf8(&format!("Zero3 Pilot 执行失败：{error:#}"), 3500),
                    message.context_token.as_deref(),
                )
                .await?;
            return Ok(());
        }
    };
    match outcome {
        SubmitOutcome::Accepted(accepted) => {
            let output = match wait_for_job(&accepted.job_id).await {
                Ok(value) => render_reply(&value),
                Err(error) => format!("Zero3 Pilot 执行失败：{error:#}"),
            };
            weixin
                .send_text(
                    &from,
                    &truncate_utf8(&output, 3500),
                    message.context_token.as_deref(),
                )
                .await?;
        }
        SubmitOutcome::Completed(value) => {
            let output = render_reply(&value);
            weixin
                .send_text(
                    &from,
                    &truncate_utf8(&output, 3500),
                    message.context_token.as_deref(),
                )
                .await?;
        }
        SubmitOutcome::ApprovalRequired(reason) => {
            approval.pending = Some(PendingApproval {
                command,
                created_at: Instant::now(),
            });
            let reason = truncate_utf8(&reason, 500);
            weixin
                .send_text(
                    &from,
                    &format!(
                        "检测到高风险/需审批操作，当前尚未执行。\n请在 2 分钟内直接发送授权码；发送 /cancel 可取消。\n权限原因：{reason}"
                    ),
                    message.context_token.as_deref(),
                )
                .await?;
        }
    }
    Ok(())
}

async fn execute_and_reply(
    weixin: &WeixinClawBotClient,
    command: RemoteCommand,
    approved: bool,
) -> anyhow::Result<()> {
    let output = match submit_and_wait(&command, approved).await {
        Ok(value) => render_reply(&value),
        Err(error) => format!("Zero3 Pilot 执行失败：{error:#}"),
    };
    weixin
        .send_text(
            &command.from_user_id,
            &truncate_utf8(&output, 3500),
            command.context_token.as_deref(),
        )
        .await?;
    Ok(())
}

fn parse_user_message<'a>(
    text: &'a str,
    default_backend: &str,
) -> anyhow::Result<(String, &'a str)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("消息不能为空"));
    }
    if !trimmed.starts_with(COMMAND_PREFIX) {
        validate_backend(default_backend)?;
        return Ok((default_backend.to_string(), trimmed));
    }
    let rest = trimmed[COMMAND_PREFIX.len()..].trim();
    if rest.is_empty() {
        return Err(anyhow!(
            "用法：直接发送消息，或 /pilot zero3|codex|claude <任务>"
        ));
    }
    parse_backend(rest, default_backend)
}

fn parse_backend<'a>(text: &'a str, default_backend: &str) -> anyhow::Result<(String, &'a str)> {
    let mut parts = text.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or_default();
    if matches!(first, "zero3" | "codex" | "claude") {
        let goal = parts.next().unwrap_or("").trim();
        if goal.is_empty() {
            return Err(anyhow!("指定 Agent 后必须提供任务内容"));
        }
        Ok((first.to_string(), goal))
    } else {
        validate_backend(default_backend)?;
        Ok((default_backend.to_string(), text))
    }
}

fn validate_backend(backend: &str) -> anyhow::Result<()> {
    if matches!(backend, "zero3" | "codex" | "claude") {
        Ok(())
    } else {
        Err(anyhow!("未知处理器 {backend:?}; 仅支持 zero3/codex/claude"))
    }
}

fn robot_gateway() -> Option<(String, String)> {
    let url = std::env::var("ZERO3_ROBOT_GATEWAY_URL")
        .ok()?
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("ZERO3_ROBOT_GATEWAY_TOKEN").ok()?;
    if url.is_empty() || token.is_empty() {
        None
    } else {
        Some((url, token))
    }
}

async fn ensure_router_healthy() -> anyhow::Result<()> {
    if robot_gateway().is_some() {
        return Ok(());
    }
    ensure_node_healthy().await
}

async fn ensure_node_healthy() -> anyhow::Result<()> {
    let response = reqwest::get(format!("{}/health", node_url()))
        .await
        .context("连接本地 Zero3 Pilot Node")?;
    if response.status() != StatusCode::OK {
        return Err(anyhow!(
            "本地 Zero3 Pilot Node 未就绪: {}",
            response.status()
        ));
    }
    Ok(())
}

async fn submit_agent(command: &RemoteCommand, approved: bool) -> anyhow::Result<SubmitOutcome> {
    let client = reqwest::Client::new();
    if let Some((gateway_url, gateway_token)) = robot_gateway() {
        let response = client
            .post(format!("{gateway_url}/v1/route"))
            .bearer_auth(gateway_token)
            .json(&json!({
                "channel": "weixin",
                "backend": command.backend,
                "text": command.goal,
                "approved": approved,
                "sender_id": command.from_user_id,
                "chat_id": command.session_id,
                "message_id": command.message_id,
            }))
            .send()
            .await
            .context("提交微信消息到 Zero3 Robot Gateway")?;
        let status = response.status();
        if status == StatusCode::PRECONDITION_REQUIRED {
            return Ok(SubmitOutcome::ApprovalRequired(
                api_error_message(response).await,
            ));
        }
        if !status.is_success() {
            let message = api_error_message(response).await;
            return Err(anyhow!(
                "Zero3 Robot Gateway 拒绝微信消息 ({status}): {message}"
            ));
        }
        let value = response
            .json::<Value>()
            .await
            .context("解析 Zero3 Robot Gateway 回复")?;
        return Ok(SubmitOutcome::Completed(value));
    }
    let response = client
        .post(format!("{}/api/v1/jobs/agent", node_url()))
        .json(&json!({
            "backend": command.backend,
            "goal": command.goal,
            "context": {
                "channel": "weixin-clawbot",
                "from_user_id": command.from_user_id,
                "session_id": command.session_id,
                "message_id": command.message_id,
            },
            "granted_level": "Standard",
            "approved": approved,
        }))
        .send()
        .await
        .context("提交微信指令到 Zero3 Pilot Node")?;

    let status = response.status();
    if status == StatusCode::PRECONDITION_REQUIRED {
        return Ok(SubmitOutcome::ApprovalRequired(
            api_error_message(response).await,
        ));
    }
    if !status.is_success() {
        let message = api_error_message(response).await;
        return Err(anyhow!(
            "Zero3 Pilot Node 拒绝微信指令 ({status}): {message}"
        ));
    }

    let accepted = response
        .json::<AcceptedJob>()
        .await
        .context("解析 Zero3 Pilot Job ID")?;
    Ok(SubmitOutcome::Accepted(accepted))
}

async fn submit_and_wait(command: &RemoteCommand, approved: bool) -> anyhow::Result<Value> {
    match submit_agent(command, approved).await? {
        SubmitOutcome::Accepted(accepted) => wait_for_job(&accepted.job_id).await,
        SubmitOutcome::Completed(value) => Ok(value),
        SubmitOutcome::ApprovalRequired(reason) => Err(anyhow!(
            "授权后操作仍被权限层要求审批，已停止执行: {reason}"
        )),
    }
}

async fn wait_for_job(job_id: &str) -> anyhow::Result<Value> {
    let client = reqwest::Client::new();
    for _ in 0..300 {
        let job = client
            .get(format!("{}/api/v1/jobs/{job_id}", node_url()))
            .send()
            .await
            .context("读取 Zero3 Pilot Job 状态")?
            .error_for_status()?
            .json::<JobRecord>()
            .await?;
        match job.status.as_str() {
            "Succeeded" => return Ok(job.output.unwrap_or(Value::Null)),
            "Failed" | "Cancelled" => {
                return Err(anyhow!(job.error.unwrap_or_else(|| job.status.clone())));
            }
            _ => sleep(Duration::from_secs(1)).await,
        }
    }
    Err(anyhow!("Zero3 Pilot Job 超过 5 分钟仍未完成"))
}

async fn api_error_message(response: reqwest::Response) -> String {
    match response.text().await {
        Ok(body) => serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| body.trim().to_string()),
        Err(error) => format!("读取错误响应失败: {error}"),
    }
}

fn render_reply(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(summary) = value.get("summary").and_then(Value::as_str) {
        return summary.to_string();
    }
    if let Some(output) = value.get("output").and_then(Value::as_str) {
        return output.to_string();
    }
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn truncate_utf8(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut value: String = text.chars().take(max_chars.saturating_sub(16)).collect();
    value.push_str("\n…(已截断)");
    value
}

fn status_label(status: &WeixinConnectionStatus) -> String {
    format!(
        "bot_id={} owner={}",
        status.bot_id.as_deref().unwrap_or("?"),
        status.owner_user_id.as_deref().unwrap_or("?")
    )
}

/// Windows `cmd.exe` splits its command line on `&` before `start` ever sees it,
/// so an unquoted QR link such as `https://…/q/7GiQu1?qrcode=…&bot_type=3` opens
/// in the browser truncated at the first `&` (and `bot_type=3` is then run as a
/// command). 微信 rejects the truncated link with 网络错误. Quoting the URL keeps
/// it intact; URLs that quoting cannot make safe — a literal quote, or a `%`
/// that `cmd /C` may expand as an environment variable — get no command line and
/// are opened without a shell instead.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_start_command_line(url: &str) -> Option<String> {
    if url.is_empty()
        || url.contains(['"', '%'])
        || url
            .chars()
            .any(|value| value.is_whitespace() || value.is_control())
    {
        return None;
    }
    // Do not run cmd AutoRun hooks or expand !variables! in the URL.
    Some(format!("/D /V:OFF /C start \"\" \"{url}\""))
}

fn open_qr_url(url: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let started = match windows_start_command_line(url) {
            Some(command_line) => Command::new("cmd").raw_arg(command_line).spawn().is_ok(),
            None => false,
        };
        if !started {
            Command::new("rundll32.exe")
                .arg("url.dll,FileProtocolHandler")
                .arg(url)
                .spawn()
                .context("打开微信 ClawBot 二维码链接")?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_backend_overrides_default() {
        let (backend, goal) = parse_backend("claude inspect this", "codex").unwrap();
        assert_eq!(backend, "claude");
        assert_eq!(goal, "inspect this");
        let (backend, goal) = parse_backend("inspect this", "codex").unwrap();
        assert_eq!(backend, "codex");
        assert_eq!(goal, "inspect this");
    }

    #[test]
    fn plain_text_routes_to_zero3_by_default() {
        let (backend, goal) = parse_user_message("你好，介绍一下自己", "zero3").unwrap();
        assert_eq!(backend, "zero3");
        assert_eq!(goal, "你好，介绍一下自己");
        let (backend, goal) = parse_user_message("/pilot codex inspect this", "zero3").unwrap();
        assert_eq!(backend, "codex");
        assert_eq!(goal, "inspect this");
    }

    #[test]
    fn truncation_preserves_utf8() {
        let text = "零三".repeat(2000);
        let truncated = truncate_utf8(&text, 100);
        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(truncated.chars().count() <= 100);
    }

    #[test]
    fn qr_url_query_survives_cmd_quoting() {
        let url = "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=94c252e1&bot_type=3";
        let command_line = windows_start_command_line(url).unwrap();
        assert_eq!(command_line, format!("/D /V:OFF /C start \"\" \"{url}\""));
        assert!(command_line.ends_with("&bot_type=3\""));
    }

    #[test]
    fn unsafe_qr_urls_get_no_cmd_command_line() {
        assert!(windows_start_command_line("https://example.test/\" & calc").is_none());
        assert!(windows_start_command_line("https://example.test/?q=%PATH%").is_none());
        assert!(windows_start_command_line("https://example.test/a b").is_none());
        assert!(windows_start_command_line("").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_cmd_preserves_complete_qr_url() {
        use std::os::windows::process::CommandExt;

        let url = "https://example.test/q?id=123&bot_type=3&literal=!ZERO3_QR_TEST!";
        // Exercise cmd's real parser without launching a browser.
        let command_line =
            windows_start_command_line(url)
                .unwrap()
                .replacen("start \"\"", "echo", 1);
        let output = Command::new("cmd")
            .raw_arg(command_line)
            .env("ZERO3_QR_TEST", "must-not-expand")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("\"{url}\"")
        );
    }

    #[test]
    fn approval_session_locks_after_five_failures() {
        let mut session = ApprovalSession::default();
        for _ in 0..4 {
            assert!(!session.register_failure());
        }
        assert!(session.register_failure());
        assert!(session.lockout_remaining().is_some());
    }

    #[test]
    fn notify_text_rejects_blank_and_truncates() {
        assert!(notify_text(" \n ").is_err());
        assert_eq!(notify_text("  告警\n").unwrap(), "告警");
        assert!(notify_text(&"零".repeat(5000)).unwrap().chars().count() <= 3500);
    }
}
