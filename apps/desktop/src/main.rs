#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Zero3 Pilot desktop shell is Windows-first; build zero3-pilot-node for local runtime use on this platform.");
}

#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    windows::run()
}

#[cfg(target_os = "windows")]
mod windows {
    use std::env;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use wry::WebViewBuilder;

    const DEFAULT_PORT: u16 = 8790;
    const START_TIMEOUT: Duration = Duration::from_secs(12);

    #[derive(Debug, Clone, Copy)]
    enum AppEvent {
        Exit,
    }

    struct OwnedNode(Option<Child>);

    impl OwnedNode {
        fn stop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    impl Drop for OwnedNode {
        fn drop(&mut self) {
            self.stop();
        }
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let port = env::var("ZERO3_PILOT_NODE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let mut owned_node = OwnedNode(None);

        if !node_healthy(port) {
            let binary = resolve_node_binary()?;
            let child = Command::new(&binary)
                .env("ZERO3_PILOT_NODE_PORT", port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    format!(
                        "failed to start Zero3 Pilot Node at {}: {error}",
                        binary.display()
                    )
                })?;
            owned_node.0 = Some(child);
            wait_for_node(port)?;
        }

        let event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title("Zero3 Pilot · 你的个人电脑智能体")
            .with_inner_size(LogicalSize::new(1280.0, 820.0))
            .with_min_inner_size(LogicalSize::new(920.0, 620.0))
            .build(&event_loop)?;
        let url = format!("http://127.0.0.1:{port}/");
        let _webview = WebViewBuilder::new().with_url(url).build(&window)?;

        if let Some(ms) = env::var("ZERO3_DESKTOP_SMOKE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
        {
            let proxy = event_loop.create_proxy();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(ms.max(250)));
                let _ = proxy.send_event(AppEvent::Exit);
            });
        }

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(AppEvent::Exit)
                | Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    owned_node.stop();
                    *control_flow = ControlFlow::Exit;
                }
                _ => {}
            }
        });
    }

    fn resolve_node_binary() -> Result<PathBuf, Box<dyn std::error::Error>> {
        if let Some(path) = env::var_os("ZERO3_PILOT_NODE_BIN") {
            return Ok(PathBuf::from(path));
        }
        if let Ok(current) = env::current_exe() {
            if let Some(parent) = current.parent() {
                let sibling = parent.join("zero3-pilot-node.exe");
                if sibling.is_file() {
                    return Ok(sibling);
                }
            }
        }
        Ok(PathBuf::from("zero3-pilot-node.exe"))
    }

    fn wait_for_node(port: u16) -> Result<(), Box<dyn std::error::Error>> {
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if node_healthy(port) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(150));
        }
        Err(format!(
            "Zero3 Pilot Node did not become healthy on 127.0.0.1:{port} within {:?}",
            START_TIMEOUT
        )
        .into())
    }

    fn node_healthy(port: u16) -> bool {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
        let request =
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut response = String::new();
        if stream.read_to_string(&mut response).is_err() {
            return false;
        }
        response.contains("200 OK") && response.contains("\"status\":\"ok\"")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn explicit_node_binary_wins() {
            let previous = env::var_os("ZERO3_PILOT_NODE_BIN");
            env::set_var("ZERO3_PILOT_NODE_BIN", r"C:\\zero3\\node.exe");
            assert_eq!(
                resolve_node_binary().unwrap(),
                PathBuf::from(r"C:\\zero3\\node.exe")
            );
            match previous {
                Some(value) => env::set_var("ZERO3_PILOT_NODE_BIN", value),
                None => env::remove_var("ZERO3_PILOT_NODE_BIN"),
            }
        }
    }
}
