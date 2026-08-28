use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use base64::Engine;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::{Page, ScreenshotParams};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::provider::Provider;

const BACKEND_VERSION: &str = "chromiumoxide-0.9.1";
const DEFAULT_WAIT_MS: u64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserMode {
    Managed,
    Attach,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrowserSelector {
    Css { value: String },
    Text { value: String },
    RoleName { role: String, name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrowserTarget {
    Ref { value: String },
    Css { value: String },
    Text { value: String },
    RoleName { role: String, name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BrowserAction {
    Launch {
        executable: Option<String>,
        headless: bool,
    },
    Connect {
        endpoint: String,
    },
    Close,
    Tabs,
    Open {
        url: String,
    },
    Navigate {
        url: String,
    },
    Snapshot,
    Query {
        selector: BrowserSelector,
    },
    Click {
        target: BrowserTarget,
    },
    Type {
        target: BrowserTarget,
        text: String,
    },
    PressKey {
        key: String,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
    },
    Wait {
        selector: BrowserSelector,
        timeout_ms: Option<u64>,
    },
    Screenshot,
    Evaluate {
        expression: String,
    },
    /// Compatibility action kept for callers from the Phase 1 seam.
    ReadText,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrowserElement {
    pub reference: String,
    pub selector: String,
    pub tag: String,
    pub role: String,
    pub name: String,
    pub text: String,
    pub enabled: bool,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrowserSnapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    pub elements: Vec<BrowserElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserActionResult {
    pub ok: bool,
    pub detail: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserHealth {
    pub mode: BrowserMode,
    pub browser_version: String,
    pub protocol_version: String,
    pub backend_version: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("browser is not started or attached")]
    NotConnected,
    #[error("browser already has an active session")]
    AlreadyConnected,
    #[error("browser handler task exited unexpectedly")]
    HandlerExited,
    #[error("no active browser page")]
    NoActivePage,
    #[error("browser wait timed out after {0}ms")]
    WaitTimeout(u64),
}

/// Backend-agnostic browser automation seam. Concrete CDP types never cross
/// this trait boundary, so a Playwright/remote backend can be substituted later.
#[async_trait]
pub trait BrowserProvider: Provider {
    async fn execute(&self, action: BrowserAction) -> anyhow::Result<BrowserActionResult>;
}

struct BrowserSession {
    mode: BrowserMode,
    browser: Browser,
    active_page: Option<Page>,
    handler: JoinHandle<()>,
    _profile: Option<TempDir>,
}

/// Real CDP-backed browser provider. Managed sessions launch an isolated
/// temporary profile; attach sessions connect to an explicitly supplied CDP
/// endpoint and never close the user's whole browser on `Close`.
pub struct CdpBrowserProvider {
    session: Mutex<Option<BrowserSession>>,
}

impl Default for CdpBrowserProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CdpBrowserProvider {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    async fn launch(&self, executable: Option<String>, headless: bool) -> anyhow::Result<Value> {
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return Err(BrowserError::AlreadyConnected.into());
        }

        let profile = tempfile::Builder::new()
            .prefix("zero3-pilot-browser-")
            .tempdir()
            .context("create isolated browser profile")?;
        let mut builder = BrowserConfig::builder().user_data_dir(profile.path());
        if !headless {
            builder = builder.with_head();
        }
        if let Some(path) = executable {
            builder = builder.chrome_executable(path);
        }
        let config = builder
            .build()
            .map_err(|error| anyhow!("build Chromium launch config: {error}"))?;
        let (browser, handler) = Browser::launch(config)
            .await
            .context("launch Chromium through CDP")?;
        let handler = drive_handler(handler);
        let page = browser
            .new_page("about:blank")
            .await
            .context("create initial browser page")?;
        let version = browser.version().await.context("read browser version")?;
        let detail = json!({
            "mode": "managed",
            "browser_version": version.product,
            "protocol_version": version.protocol_version,
            "backend_version": BACKEND_VERSION,
        });
        *guard = Some(BrowserSession {
            mode: BrowserMode::Managed,
            browser,
            active_page: Some(page),
            handler,
            _profile: Some(profile),
        });
        Ok(detail)
    }

    async fn connect(&self, endpoint: String) -> anyhow::Result<Value> {
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return Err(BrowserError::AlreadyConnected.into());
        }
        let (mut browser, handler) = Browser::connect(endpoint)
            .await
            .context("attach to CDP endpoint")?;
        let handler = drive_handler(handler);
        let _ = browser.fetch_targets().await;
        let pages = browser.pages().await.context("enumerate attached pages")?;
        let active_page = pages.into_iter().next();
        let version = browser.version().await.context("read browser version")?;
        let detail = json!({
            "mode": "attach",
            "browser_version": version.product,
            "protocol_version": version.protocol_version,
            "backend_version": BACKEND_VERSION,
        });
        *guard = Some(BrowserSession {
            mode: BrowserMode::Attach,
            browser,
            active_page,
            handler,
            _profile: None,
        });
        Ok(detail)
    }

    async fn close(&self) -> anyhow::Result<Value> {
        let mut session = self
            .session
            .lock()
            .await
            .take()
            .ok_or(BrowserError::NotConnected)?;
        let mode = session.mode.clone();
        if mode == BrowserMode::Managed {
            session
                .browser
                .close()
                .await
                .context("close managed Chromium")?;
        }
        session.handler.abort();
        Ok(json!({ "mode": mode, "closed": true }))
    }

    async fn with_session<T>(
        &self,
        f: impl for<'a> FnOnce(
                &'a mut BrowserSession,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>,
            > + Send,
    ) -> anyhow::Result<T> {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or(BrowserError::NotConnected)?;
        if session.handler.is_finished() {
            return Err(BrowserError::HandlerExited.into());
        }
        f(session).await
    }

    async fn active_page(session: &BrowserSession) -> anyhow::Result<Page> {
        session
            .active_page
            .clone()
            .ok_or_else(|| BrowserError::NoActivePage.into())
    }

    async fn query_on_page(
        page: &Page,
        selector: &BrowserSelector,
    ) -> anyhow::Result<Vec<BrowserElement>> {
        let predicate = match selector {
            BrowserSelector::Css { value } => {
                let value = serde_json::to_string(value)?;
                format!("el.matches({value})")
            }
            BrowserSelector::Text { value } => {
                let value = serde_json::to_string(&value.to_lowercase())?;
                format!("(el.innerText || el.value || '').toLowerCase().includes({value})")
            }
            BrowserSelector::RoleName { role, name } => {
                let role = serde_json::to_string(&role.to_lowercase())?;
                let name = serde_json::to_string(&name.to_lowercase())?;
                format!("roleOf(el).toLowerCase() === {role} && nameOf(el).toLowerCase().includes({name})")
            }
        };
        let script = semantic_elements_script(&predicate);
        let result = page
            .evaluate(script)
            .await
            .context("query page semantics")?;
        result
            .into_value::<Vec<BrowserElement>>()
            .context("decode browser query result")
    }

    async fn resolve_target(page: &Page, target: &BrowserTarget) -> anyhow::Result<String> {
        match target {
            BrowserTarget::Ref { value } | BrowserTarget::Css { value } => Ok(value.clone()),
            BrowserTarget::Text { value } => Self::query_on_page(
                page,
                &BrowserSelector::Text {
                    value: value.clone(),
                },
            )
            .await?
            .into_iter()
            .next()
            .map(|item| item.selector)
            .ok_or_else(|| anyhow!("no element matched text {value:?}")),
            BrowserTarget::RoleName { role, name } => Self::query_on_page(
                page,
                &BrowserSelector::RoleName {
                    role: role.clone(),
                    name: name.clone(),
                },
            )
            .await?
            .into_iter()
            .next()
            .map(|item| item.selector)
            .ok_or_else(|| anyhow!("no element matched role/name {role:?}/{name:?}")),
        }
    }
}

#[async_trait]
impl Provider for CdpBrowserProvider {
    fn name(&self) -> &str {
        "cdp-chromiumoxide"
    }

    fn capabilities(&self) -> Vec<String> {
        [
            "launch",
            "connect",
            "tabs",
            "open",
            "navigate",
            "snapshot",
            "query",
            "click",
            "type",
            "press_key",
            "scroll",
            "wait",
            "screenshot",
            "evaluate",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        self.with_session(|session| {
            Box::pin(async move {
                session
                    .browser
                    .version()
                    .await
                    .context("browser health/version")?;
                Ok(())
            })
        })
        .await
    }
}

#[async_trait]
impl BrowserProvider for CdpBrowserProvider {
    async fn execute(&self, action: BrowserAction) -> anyhow::Result<BrowserActionResult> {
        let detail = match action {
            BrowserAction::Launch {
                executable,
                headless,
            } => self.launch(executable, headless).await?,
            BrowserAction::Connect { endpoint } => self.connect(endpoint).await?,
            BrowserAction::Close => self.close().await?,
            BrowserAction::Tabs => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let pages = session.browser.pages().await.context("list browser tabs")?;
                        let mut tabs = Vec::with_capacity(pages.len());
                        for page in pages {
                            tabs.push(json!({
                                "target_id": format!("{:?}", page.target_id()),
                                "url": page.url().await?.unwrap_or_default(),
                                "title": page.get_title().await?.unwrap_or_default(),
                            }));
                        }
                        Ok(json!({ "tabs": tabs }))
                    })
                })
                .await?
            }
            BrowserAction::Open { url } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = session
                            .browser
                            .new_page(url)
                            .await
                            .context("open browser tab")?;
                        let url = page.url().await?.unwrap_or_default();
                        session.active_page = Some(page);
                        Ok(json!({ "url": url }))
                    })
                })
                .await?
            }
            BrowserAction::Navigate { url } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        page.goto(url).await.context("navigate browser page")?;
                        Ok(json!({ "url": page.url().await?.unwrap_or_default() }))
                    })
                })
                .await?
            }
            BrowserAction::Snapshot => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let result = page
                            .evaluate(snapshot_script())
                            .await
                            .context("capture semantic browser snapshot")?;
                        let snapshot = result
                            .into_value::<BrowserSnapshot>()
                            .context("decode semantic browser snapshot")?;
                        Ok(serde_json::to_value(snapshot)?)
                    })
                })
                .await?
            }
            BrowserAction::Query { selector } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let elements = Self::query_on_page(&page, &selector).await?;
                        Ok(json!({ "elements": elements }))
                    })
                })
                .await?
            }
            BrowserAction::Click { target } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let selector = Self::resolve_target(&page, &target).await?;
                        page.find_element(selector.clone())
                            .await
                            .with_context(|| format!("find click target {selector:?}"))?
                            .click()
                            .await
                            .context("click browser target")?;
                        Ok(json!({ "selector": selector }))
                    })
                })
                .await?
            }
            BrowserAction::Type { target, text } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let selector = Self::resolve_target(&page, &target).await?;
                        let element = page
                            .find_element(selector.clone())
                            .await
                            .with_context(|| format!("find type target {selector:?}"))?;
                        element.click().await.context("focus type target")?;
                        element
                            .type_str(text)
                            .await
                            .context("type into browser target")?;
                        Ok(json!({ "selector": selector }))
                    })
                })
                .await?
            }
            BrowserAction::PressKey { key } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let element = match page.find_element(":focus").await {
                            Ok(element) => element,
                            Err(_) => page.find_element("body").await.context("find page body")?,
                        };
                        element
                            .press_key(key.clone())
                            .await
                            .context("press browser key")?;
                        Ok(json!({ "key": key }))
                    })
                })
                .await?
            }
            BrowserAction::Scroll { delta_x, delta_y } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let script = format!(
                            "window.scrollBy({delta_x}, {delta_y}); ({})",
                            "({x: window.scrollX, y: window.scrollY})"
                        );
                        let value = page.evaluate(script).await?.into_value::<Value>()?;
                        Ok(value)
                    })
                })
                .await?
            }
            BrowserAction::Wait {
                selector,
                timeout_ms,
            } => {
                let timeout_ms = timeout_ms.unwrap_or(DEFAULT_WAIT_MS).max(1);
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let started = tokio::time::Instant::now();
                        loop {
                            if !Self::query_on_page(&page, &selector).await?.is_empty() {
                                return Ok(json!({ "matched": true }));
                            }
                            if started.elapsed() >= Duration::from_millis(timeout_ms) {
                                return Err(BrowserError::WaitTimeout(timeout_ms).into());
                            }
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    })
                })
                .await?
            }
            BrowserAction::Screenshot => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let bytes = page
                            .screenshot(ScreenshotParams::builder().full_page(true).build())
                            .await
                            .context("capture browser screenshot")?;
                        Ok(json!({
                            "mime_type": "image/png",
                            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
                        }))
                    })
                })
                .await?
            }
            BrowserAction::Evaluate { expression } => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let result = page
                            .evaluate(expression)
                            .await
                            .context("evaluate page script")?;
                        let value = result.into_value::<Value>().unwrap_or(Value::Null);
                        Ok(json!({ "value": value }))
                    })
                })
                .await?
            }
            BrowserAction::ReadText => {
                self.with_session(|session| {
                    Box::pin(async move {
                        let page = Self::active_page(session).await?;
                        let result = page
                            .evaluate("document.body ? document.body.innerText : ''")
                            .await?;
                        let text = result.into_value::<String>().unwrap_or_default();
                        Ok(json!({ "text": text }))
                    })
                })
                .await?
            }
        };
        Ok(BrowserActionResult { ok: true, detail })
    }
}

fn drive_handler(mut handler: chromiumoxide::Handler) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = handler.next().await {
            if message.is_err() {
                break;
            }
        }
    })
}

fn semantic_helpers() -> &'static str {
    r#"
const roleOf = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:(el.type === 'checkbox' ? 'checkbox' : 'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName] || '');
const nameOf = (el) => el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '';
const cssPath = (el) => {
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(x => x.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
};
const describe = (el) => {
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const selector = cssPath(el);
  return {
    reference: selector,
    selector,
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: String(nameOf(el)).trim().slice(0, 512),
    text: String(el.innerText || el.value || '').trim().slice(0, 1024),
    enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
  };
};
"#
}

fn semantic_elements_script(predicate: &str) -> String {
    format!(
        r#"(() => {{
{helpers}
const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]'));
return nodes.filter(el => {predicate}).slice(0, 500).map(describe);
}})()"#,
        helpers = semantic_helpers(),
        predicate = predicate
    )
}

fn snapshot_script() -> String {
    format!(
        r#"(() => {{
{helpers}
const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]')).slice(0, 500);
return {{
  url: location.href,
  title: document.title,
  text: String(document.body ? document.body.innerText : '').slice(0, 20000),
  elements: nodes.map(describe),
}};
}})()"#,
        helpers = semantic_helpers()
    )
}

pub struct UnimplementedBrowserProvider;

#[async_trait]
impl Provider for UnimplementedBrowserProvider {
    fn name(&self) -> &str {
        "unimplemented"
    }

    async fn health_check(&self) -> anyhow::Result<()> {
        anyhow::bail!("no BrowserProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[async_trait]
impl BrowserProvider for UnimplementedBrowserProvider {
    async fn execute(&self, _action: BrowserAction) -> anyhow::Result<BrowserActionResult> {
        anyhow::bail!("no BrowserProvider wired up yet (see docs/ARCHITECTURE.md)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unimplemented_provider_never_reports_success() {
        let provider = UnimplementedBrowserProvider;
        assert!(provider
            .execute(BrowserAction::Navigate {
                url: "https://example.com".into()
            })
            .await
            .is_err());
        assert!(provider.health_check().await.is_err());
        assert!(provider.capabilities().is_empty());
    }

    #[test]
    fn semantic_contract_has_no_chromiumoxide_types() {
        let action = BrowserAction::Click {
            target: BrowserTarget::RoleName {
                role: "button".into(),
                name: "Save".into(),
            },
        };
        let encoded = serde_json::to_string(&action).unwrap();
        assert!(encoded.contains("role_name"));
        assert!(!encoded.contains("chromiumoxide"));
    }
}
