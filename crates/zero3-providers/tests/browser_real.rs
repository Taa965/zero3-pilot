use std::env;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zero3_providers::browser::{
    BrowserAction, BrowserProvider, BrowserSelector, BrowserTarget, CdpBrowserProvider,
};

async fn fixture_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let body = r#"<!doctype html>
<html>
<head><title>Zero3 Browser Fixture</title></head>
<body>
  <label>Name <input id="name" aria-label="Name" /></label>
  <button id="go" onclick="document.getElementById('status').textContent='clicked:' + document.getElementById('name').value">Go</button>
  <div id="status" role="status">idle</div>
</body>
</html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (format!("http://{addr}/"), handle)
}

/// Real Chromium integration gate. Kept ignored for normal developer/unit
/// runs; CI invokes it explicitly on a runner with Chrome installed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a real Chrome/Chromium executable"]
async fn real_chromium_semantic_agent_flow() {
    let (url, server) = fixture_server().await;
    let provider = CdpBrowserProvider::new();
    let executable = env::var("ZERO3_CHROME_PATH").ok();

    provider
        .execute(BrowserAction::Launch {
            executable,
            headless: true,
        })
        .await
        .unwrap();
    provider
        .execute(BrowserAction::Navigate { url })
        .await
        .unwrap();

    let snapshot = provider.execute(BrowserAction::Snapshot).await.unwrap();
    assert_eq!(snapshot.detail["title"], "Zero3 Browser Fixture");
    assert!(snapshot.detail["elements"].as_array().unwrap().len() >= 2);

    let query = provider
        .execute(BrowserAction::Query {
            selector: BrowserSelector::RoleName {
                role: "button".into(),
                name: "Go".into(),
            },
        })
        .await
        .unwrap();
    assert_eq!(query.detail["elements"].as_array().unwrap().len(), 1);

    provider
        .execute(BrowserAction::Type {
            target: BrowserTarget::Css {
                value: "#name".into(),
            },
            text: "pilot".into(),
        })
        .await
        .unwrap();
    provider
        .execute(BrowserAction::Click {
            target: BrowserTarget::RoleName {
                role: "button".into(),
                name: "Go".into(),
            },
        })
        .await
        .unwrap();
    provider
        .execute(BrowserAction::Wait {
            selector: BrowserSelector::Text {
                value: "clicked:pilot".into(),
            },
            timeout_ms: Some(5_000),
        })
        .await
        .unwrap();

    let evaluated = provider
        .execute(BrowserAction::Evaluate {
            expression: "document.getElementById('status').textContent".into(),
        })
        .await
        .unwrap();
    assert_eq!(evaluated.detail["value"], "clicked:pilot");

    let screenshot = provider.execute(BrowserAction::Screenshot).await.unwrap();
    assert!(screenshot.detail["base64"].as_str().unwrap().len() > 100);

    provider.execute(BrowserAction::Close).await.unwrap();
    server.abort();
}
