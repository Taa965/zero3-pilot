use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, Context};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::sleep;
use zero3_providers::weixin_clawbot::{
    WeixinClawBotClient, WeixinConnectionStatus, WeixinLoginState, WeixinMessage,
};

const DEFAULT_NODE_URL: &str = "http://127.0.0.1:8790";
const COMMAND_PREFIX: &str = "/pilot";

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
    std::env::var("ZERO3_WEIXIN_AGENT").unwrap_or_else(|_| "codex".to_string())
}

fn print_usage() {
    println!(
        "Zero3 Pilot Weixin ClawBot\n\n\
         Usage:\n  zero3-pilot-weixin status\n  zero3-pilot-weixin login\n  zero3-pilot-weixin run [codex|claude|hermes]\n  zero3-pilot-weixin disconnect\n\n\
         Only messages from the WeChat account that scanned the QR code are accepted.\n\
         Remote commands must start with /pilot. Examples:\n  /pilot summarize my current task\n  /pilot hermes check today's automation status"
    );
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "help".to_string());
    let state_path = data_dir().join("weixin-clawbot.json");
    let weixin = WeixinClawBotClient::open(state_path)?;

    match command.as_str() {
        "status" => {
            let status = weixin.status().await;
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
        "login" => login(&weixin).await?,
        "run" => {
            let backend = std::env::args().nth(2).unwrap_or_else(default_backend);
            validate_backend(&backend)?;
            run_bridge(&weixin, &backend).await?;
        }
        "disconnect" => {
            weixin.disconnect().await?;
            println!("微信 ClawBot 本地授权已移除。需要再次使用时重新运行 login。")
        }
        _ => print_usage(),
    }
    Ok(())
}

async fn login(weixin: &WeixinClawBotClient) -> anyhow::Result<()> {
    let current = weixin.status().await;
    if current.connected {
        println!("微信 ClawBot 已连接：{}", status_label(&current));
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
                print!("配对码: ");
                io::stdout().flush()?;
                let mut line = String::new();
                io::stdin().read_line(&mut line)?;
                verify_code = Some(line.trim().to_string());
            }
            WeixinLoginState::Connected | WeixinLoginState::AlreadyConnected => {
                println!("连接完成。现在可运行 zero3-pilot-weixin run。");
                return Ok(());
            }
            WeixinLoginState::Expired | WeixinLoginState::VerifyCodeBlocked => {
                return Err(anyhow!(poll.message));
            }
        }
    }
}

async fn run_bridge(weixin: &WeixinClawBotClient, backend: &str) -> anyhow::Result<()> {
    let status = weixin.status().await;
    if !status.connected {
        return Err(anyhow!(
            "微信 ClawBot 尚未连接。先运行 zero3-pilot-weixin login"
        ));
    }
    ensure_node_healthy().await?;
    println!(
        "微信 ClawBot 已连接到 Zero3 Pilot。默认 Agent={backend}。仅处理 {COMMAND_PREFIX} 指令。"
    );

    loop {
        match weixin.get_updates().await {
            Ok(messages) => {
                for message in messages {
                    if let Err(error) = handle_message(weixin, message, backend).await {
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
    message: WeixinMessage,
    default_backend: &str,
) -> anyhow::Result<()> {
    let Some(from) = message.from_user_id.as_deref() else {
        return Ok(());
    };
    let owner = weixin.owner_user_id().await;
    if owner.as_deref() != Some(from) {
        return Ok(());
    }
    let Some(text) = message.text() else {
        return Ok(());
    };
    let trimmed = text.trim();
    if !trimmed.starts_with(COMMAND_PREFIX) {
        return Ok(());
    }
    let rest = trimmed[COMMAND_PREFIX.len()..].trim();
    if rest.is_empty() {
        weixin
            .send_text(
                from,
                "用法：/pilot <任务>，或 /pilot codex|claude|hermes <任务>",
                message.context_token.as_deref(),
            )
            .await?;
        return Ok(());
    }

    let (backend, goal) = parse_backend(rest, default_backend)?;
    let output = match submit_and_wait(&backend, goal, &message).await {
        Ok(value) => render_reply(&value),
        Err(error) => format!("Zero3 Pilot 执行失败：{error:#}"),
    };
    weixin
        .send_text(
            from,
            &truncate_utf8(&output, 3500),
            message.context_token.as_deref(),
        )
        .await?;
    Ok(())
}

fn parse_backend<'a>(text: &'a str, default_backend: &str) -> anyhow::Result<(String, &'a str)> {
    let mut parts = text.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or_default();
    if matches!(first, "codex" | "claude" | "hermes") {
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
    if matches!(backend, "codex" | "claude" | "hermes") {
        Ok(())
    } else {
        Err(anyhow!(
            "未知 Agent {backend:?}; 仅支持 codex/claude/hermes"
        ))
    }
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

async fn submit_and_wait(
    backend: &str,
    goal: &str,
    message: &WeixinMessage,
) -> anyhow::Result<Value> {
    let client = reqwest::Client::new();
    let accepted = client
        .post(format!("{}/api/v1/jobs/agent", node_url()))
        .json(&json!({
            "backend": backend,
            "goal": goal,
            "context": {
                "channel": "weixin-clawbot",
                "from_user_id": message.from_user_id,
                "session_id": message.session_id,
                "message_id": message.message_id,
            },
            "granted_level": "Standard",
            "approved": true
        }))
        .send()
        .await
        .context("提交微信指令到 Zero3 Pilot Node")?
        .error_for_status()
        .context("Zero3 Pilot Node 拒绝微信指令")?
        .json::<AcceptedJob>()
        .await
        .context("解析 Zero3 Pilot Job ID")?;

    for _ in 0..300 {
        let job = client
            .get(format!("{}/api/v1/jobs/{}", node_url(), accepted.job_id))
            .send()
            .await
            .context("读取 Zero3 Pilot Job 状态")?
            .error_for_status()?
            .json::<JobRecord>()
            .await?;
        match job.status.as_str() {
            "Succeeded" => return Ok(job.output.unwrap_or(Value::Null)),
            "Failed" | "Cancelled" => {
                return Err(anyhow!(job.error.unwrap_or_else(|| job.status.clone())))
            }
            _ => sleep(Duration::from_secs(1)).await,
        }
    }
    Err(anyhow!("Zero3 Pilot Job 超过 5 分钟仍未完成"))
}

fn render_reply(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
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

fn open_qr_url(url: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .context("打开微信 ClawBot 二维码链接")?;
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
        let (backend, goal) = parse_backend("hermes inspect this", "codex").unwrap();
        assert_eq!(backend, "hermes");
        assert_eq!(goal, "inspect this");
        let (backend, goal) = parse_backend("inspect this", "codex").unwrap();
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
}
