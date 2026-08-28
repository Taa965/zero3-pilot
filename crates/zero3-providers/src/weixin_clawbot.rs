use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE: &str = "3";
const CLIENT_VERSION: &str = "0.1.0";
const APP_ID: &str = "bot";
const BOT_AGENT: &str = "Zero3Pilot/0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinCredentials {
    pub bot_token: String,
    pub bot_id: String,
    pub owner_user_id: String,
    pub base_url: String,
    #[serde(default)]
    pub get_updates_buf: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeixinConnectionStatus {
    pub connected: bool,
    pub bot_id: Option<String>,
    pub owner_user_id: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeixinLoginStart {
    pub session_key: String,
    pub qrcode_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeixinLoginState {
    Waiting,
    Scanned,
    NeedVerifyCode,
    Connected,
    AlreadyConnected,
    Expired,
    VerifyCodeBlocked,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeixinLoginPoll {
    pub state: WeixinLoginState,
    pub connected: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
struct LoginSession {
    qrcode: String,
    current_base_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct QrCodeResponse {
    qrcode: String,
    qrcode_img_content: String,
}

#[derive(Debug, Clone, Deserialize)]
struct QrStatusResponse {
    status: String,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    ilink_user_id: Option<String>,
    baseurl: Option<String>,
    redirect_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeixinMessageItem {
    #[serde(default)]
    pub r#type: u32,
    pub text_item: Option<WeixinTextItem>,
    pub voice_item: Option<WeixinVoiceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeixinTextItem {
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeixinVoiceItem {
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeixinMessage {
    pub message_id: Option<u64>,
    pub from_user_id: Option<String>,
    pub to_user_id: Option<String>,
    pub session_id: Option<String>,
    pub group_id: Option<String>,
    pub context_token: Option<String>,
    #[serde(default)]
    pub item_list: Vec<WeixinMessageItem>,
}

impl WeixinMessage {
    pub fn text(&self) -> Option<String> {
        for item in &self.item_list {
            if let Some(text) = item
                .text_item
                .as_ref()
                .and_then(|value| value.text.as_ref())
                .filter(|value| !value.trim().is_empty())
            {
                return Some(text.clone());
            }
            if let Some(text) = item
                .voice_item
                .as_ref()
                .and_then(|value| value.text.as_ref())
                .filter(|value| !value.trim().is_empty())
            {
                return Some(text.clone());
            }
        }
        None
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
struct GetUpdatesResponse {
    #[serde(default)]
    ret: i32,
    errcode: Option<i32>,
    errmsg: Option<String>,
    #[serde(default)]
    msgs: Vec<WeixinMessage>,
    get_updates_buf: Option<String>,
}

pub struct WeixinClawBotClient {
    http: reqwest::Client,
    login_base_url: String,
    state_path: PathBuf,
    credentials: Mutex<Option<WeixinCredentials>>,
    login_sessions: Mutex<HashMap<String, LoginSession>>,
}

impl WeixinClawBotClient {
    pub fn open(state_path: impl Into<PathBuf>) -> anyhow::Result<Self> {
        Self::with_base_url(state_path, DEFAULT_BASE_URL)
    }

    pub fn with_base_url(
        state_path: impl Into<PathBuf>,
        login_base_url: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let state_path = state_path.into();
        let credentials = load_credentials(&state_path)?;
        let http = reqwest::Client::builder()
            .user_agent(BOT_AGENT)
            .build()
            .context("build Weixin HTTP client")?;
        Ok(Self {
            http,
            login_base_url: login_base_url.into().trim_end_matches('/').to_string(),
            state_path,
            credentials: Mutex::new(credentials),
            login_sessions: Mutex::new(HashMap::new()),
        })
    }

    pub async fn status(&self) -> WeixinConnectionStatus {
        let credentials = self.credentials.lock().await;
        WeixinConnectionStatus {
            connected: credentials.is_some(),
            bot_id: credentials.as_ref().map(|value| value.bot_id.clone()),
            owner_user_id: credentials
                .as_ref()
                .map(|value| value.owner_user_id.clone()),
            base_url: credentials.as_ref().map(|value| value.base_url.clone()),
        }
    }

    pub async fn owner_user_id(&self) -> Option<String> {
        self.credentials
            .lock()
            .await
            .as_ref()
            .map(|value| value.owner_user_id.clone())
    }

    pub async fn start_login(&self) -> anyhow::Result<WeixinLoginStart> {
        let url = format!(
            "{}/ilink/bot/get_bot_qrcode?bot_type={}",
            self.login_base_url, DEFAULT_BOT_TYPE
        );
        let response = self
            .http
            .post(url)
            .headers(auth_headers(None)?)
            .json(&json!({"local_token_list": []}))
            .send()
            .await
            .context("request Weixin ClawBot QR code")?
            .error_for_status()
            .context("Weixin QR endpoint returned an error")?
            .json::<QrCodeResponse>()
            .await
            .context("decode Weixin QR response")?;

        let session_key = Uuid::new_v4().to_string();
        self.login_sessions.lock().await.insert(
            session_key.clone(),
            LoginSession {
                qrcode: response.qrcode,
                current_base_url: self.login_base_url.clone(),
            },
        );
        Ok(WeixinLoginStart {
            session_key,
            qrcode_url: response.qrcode_img_content,
        })
    }

    pub async fn poll_login(
        &self,
        session_key: &str,
        verify_code: Option<&str>,
    ) -> anyhow::Result<WeixinLoginPoll> {
        let session = self
            .login_sessions
            .lock()
            .await
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow!("unknown or expired Weixin login session"))?;
        let mut url = format!(
            "{}/ilink/bot/get_qrcode_status?qrcode={}",
            session.current_base_url,
            urlencoding::encode(&session.qrcode)
        );
        if let Some(code) = verify_code.filter(|value| !value.trim().is_empty()) {
            url.push_str("&verify_code=");
            url.push_str(&urlencoding::encode(code.trim()));
        }
        let response = self
            .http
            .get(url)
            .headers(common_headers()?)
            .send()
            .await
            .context("poll Weixin ClawBot QR status")?
            .error_for_status()
            .context("Weixin QR status endpoint returned an error")?
            .json::<QrStatusResponse>()
            .await
            .context("decode Weixin QR status")?;

        match response.status.as_str() {
            "wait" => Ok(login_poll(WeixinLoginState::Waiting, false, "等待扫码")),
            "scaned" => Ok(login_poll(WeixinLoginState::Scanned, false, "已扫码，等待手机确认")),
            "need_verifycode" => Ok(login_poll(
                WeixinLoginState::NeedVerifyCode,
                false,
                "请输入手机微信显示的数字配对码",
            )),
            "expired" => {
                self.login_sessions.lock().await.remove(session_key);
                Ok(login_poll(WeixinLoginState::Expired, false, "二维码已过期，请重新生成"))
            }
            "verify_code_blocked" => Ok(login_poll(
                WeixinLoginState::VerifyCodeBlocked,
                false,
                "配对码多次错误，请稍后重新连接",
            )),
            "binded_redirect" => {
                self.login_sessions.lock().await.remove(session_key);
                Ok(login_poll(
                    WeixinLoginState::AlreadyConnected,
                    true,
                    "此微信 ClawBot 已绑定",
                ))
            }
            "scaned_but_redirect" => {
                if let Some(host) = response.redirect_host {
                    if let Some(value) = self.login_sessions.lock().await.get_mut(session_key) {
                        value.current_base_url = format!("https://{host}");
                    }
                }
                Ok(login_poll(WeixinLoginState::Scanned, false, "已扫码，正在切换微信接入节点"))
            }
            "confirmed" => {
                let credentials = WeixinCredentials {
                    bot_token: response
                        .bot_token
                        .ok_or_else(|| anyhow!("Weixin login confirmed without bot_token"))?,
                    bot_id: response
                        .ilink_bot_id
                        .ok_or_else(|| anyhow!("Weixin login confirmed without ilink_bot_id"))?,
                    owner_user_id: response
                        .ilink_user_id
                        .ok_or_else(|| anyhow!("Weixin login confirmed without ilink_user_id"))?,
                    base_url: response
                        .baseurl
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(session.current_base_url),
                    get_updates_buf: String::new(),
                };
                persist_credentials(&self.state_path, &credentials)?;
                *self.credentials.lock().await = Some(credentials);
                self.login_sessions.lock().await.remove(session_key);
                Ok(login_poll(
                    WeixinLoginState::Connected,
                    true,
                    "微信 ClawBot 已连接到 Zero3 Pilot",
                ))
            }
            other => Err(anyhow!("unknown Weixin QR status {other:?}")),
        }
    }

    pub async fn disconnect(&self) -> anyhow::Result<()> {
        *self.credentials.lock().await = None;
        match std::fs::remove_file(&self.state_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("remove Weixin credential state"),
        }
    }

    pub async fn get_updates(&self) -> anyhow::Result<Vec<WeixinMessage>> {
        let credentials = self
            .credentials
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("Weixin ClawBot is not connected"))?;
        let url = format!("{}/ilink/bot/getupdates", credentials.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(url)
            .headers(auth_headers(Some(&credentials.bot_token))?)
            .timeout(std::time::Duration::from_secs(40))
            .json(&json!({
                "get_updates_buf": credentials.get_updates_buf,
                "base_info": base_info(),
            }))
            .send()
            .await
            .context("long-poll Weixin ClawBot messages")?
            .error_for_status()
            .context("Weixin getupdates returned an HTTP error")?
            .json::<GetUpdatesResponse>()
            .await
            .context("decode Weixin getupdates response")?;

        if response.ret != 0 || response.errcode.unwrap_or(0) != 0 {
            return Err(anyhow!(
                "Weixin getupdates failed ret={} errcode={} errmsg={}",
                response.ret,
                response.errcode.unwrap_or(0),
                response.errmsg.unwrap_or_default()
            ));
        }
        if let Some(buffer) = response.get_updates_buf {
            let mut guard = self.credentials.lock().await;
            if let Some(current) = guard.as_mut() {
                current.get_updates_buf = buffer;
                persist_credentials(&self.state_path, current)?;
            }
        }
        Ok(response.msgs)
    }

    pub async fn send_text(
        &self,
        to_user_id: &str,
        text: &str,
        context_token: Option<&str>,
    ) -> anyhow::Result<()> {
        let credentials = self
            .credentials
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("Weixin ClawBot is not connected"))?;
        let url = format!("{}/ilink/bot/sendmessage", credentials.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(url)
            .headers(auth_headers(Some(&credentials.bot_token))?)
            .json(&json!({
                "msg": {
                    "from_user_id": "",
                    "to_user_id": to_user_id,
                    "client_id": format!("zero3-pilot-{}", Uuid::new_v4()),
                    "message_type": 2,
                    "message_state": 2,
                    "item_list": [{"type": 1, "text_item": {"text": text}}],
                    "context_token": context_token,
                },
                "base_info": base_info(),
            }))
            .send()
            .await
            .context("send Weixin ClawBot message")?
            .error_for_status()
            .context("Weixin sendmessage returned an HTTP error")?;
        let body = response.json::<Value>().await.context("decode Weixin send response")?;
        if body.get("ret").and_then(Value::as_i64).unwrap_or(0) != 0 {
            return Err(anyhow!("Weixin sendmessage failed: {body}"));
        }
        Ok(())
    }
}

fn login_poll(state: WeixinLoginState, connected: bool, message: &str) -> WeixinLoginPoll {
    WeixinLoginPoll {
        state,
        connected,
        message: message.to_string(),
    }
}

fn base_info() -> Value {
    json!({"channel_version": CLIENT_VERSION, "bot_agent": BOT_AGENT})
}

fn common_headers() -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("iLink-App-Id", HeaderValue::from_static(APP_ID));
    headers.insert("iLink-App-ClientVersion", HeaderValue::from_static("256"));
    Ok(headers)
}

fn auth_headers(token: Option<&str>) -> anyhow::Result<HeaderMap> {
    let mut headers = common_headers()?;
    headers.insert("AuthorizationType", HeaderValue::from_static("ilink_bot_token"));
    let uin = Uuid::new_v4().as_u128() as u32;
    let encoded = base64::engine::general_purpose::STANDARD.encode(uin.to_string());
    headers.insert(
        "X-WECHAT-UIN",
        HeaderValue::from_str(&encoded).context("encode X-WECHAT-UIN header")?,
    );
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", token.trim()))
                .context("encode Weixin Authorization header")?,
        );
    }
    Ok(headers)
}

fn load_credentials(path: &Path) -> anyhow::Result<Option<WeixinCredentials>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).context("decode persisted Weixin credentials")?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("read persisted Weixin credentials"),
    }
}

fn persist_credentials(path: &Path, credentials: &WeixinCredentials) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create Weixin state directory")?;
    }
    let bytes = serde_json::to_vec_pretty(credentials).context("encode Weixin credentials")?;
    let temp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).context("create temporary Weixin state")?;
        file.write_all(&bytes).context("write temporary Weixin state")?;
        file.sync_all().context("sync temporary Weixin state")?;
    }
    std::fs::rename(&temp, path).context("atomically replace Weixin state")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_prefers_text_and_supports_voice_transcript() {
        let message = WeixinMessage {
            item_list: vec![WeixinMessageItem {
                r#type: 1,
                text_item: Some(WeixinTextItem {
                    text: Some("/pilot hello".into()),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(message.text().as_deref(), Some("/pilot hello"));

        let voice = WeixinMessage {
            item_list: vec![WeixinMessageItem {
                r#type: 3,
                voice_item: Some(WeixinVoiceItem {
                    text: Some("语音转文字".into()),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(voice.text().as_deref(), Some("语音转文字"));
    }

    #[test]
    fn credentials_round_trip_without_logging_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weixin.json");
        let credentials = WeixinCredentials {
            bot_token: "secret".into(),
            bot_id: "bot".into(),
            owner_user_id: "owner".into(),
            base_url: "https://example.invalid".into(),
            get_updates_buf: "buf".into(),
        };
        persist_credentials(&path, &credentials).unwrap();
        assert_eq!(load_credentials(&path).unwrap().unwrap().bot_token, "secret");
    }
}
