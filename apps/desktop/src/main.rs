#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!(
        "Zero3 Pilot native-shell launcher is Windows-first; use zero3-pilot-node directly on this platform."
    );
}

#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    windows::run()
}

#[cfg(target_os = "windows")]
mod windows {
    use std::env;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const DEFAULT_PORT: u16 = 8790;
    const START_TIMEOUT: Duration = Duration::from_secs(12);
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const ZERO3_CODEX_SKILL: &str =
        include_str!("../../../.agents/skills/zero3-pilot/SKILL.md");

    /// Owns a Node process only until the Codex native shell has been opened.
    ///
    /// Once hand-off succeeds the Node intentionally outlives this tiny launcher:
    /// schedules/background jobs must keep running even when the Codex window is
    /// closed. If hand-off fails, Drop cleans up the child we just started.
    struct NodeLease {
        child: Option<Child>,
        persist: bool,
    }

    impl NodeLease {
        fn empty() -> Self {
            Self {
                child: None,
                persist: false,
            }
        }

        fn attach(&mut self, child: Child) {
            self.child = Some(child);
        }

        fn persist(&mut self) {
            self.persist = true;
        }
    }

    impl Drop for NodeLease {
        fn drop(&mut self) {
            if self.persist {
                // Dropping Child does not terminate the Windows process. Taking
                // it makes the intent explicit and prevents our failure cleanup.
                let _ = self.child.take();
                return;
            }
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let port = env::var("ZERO3_PILOT_NODE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let mut node = NodeLease::empty();

        if !node_healthy(port) {
            let binary = resolve_node_binary()?;
            let mut command = Command::new(&binary);
            command
                .creation_flags(CREATE_NO_WINDOW)
                .env("ZERO3_PILOT_NODE_PORT", port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child = command.spawn().map_err(|error| {
                format!(
                    "failed to start Zero3 Pilot Node at {}: {error}",
                    binary.display()
                )
            })?;
            node.attach(child);
            wait_for_node(port)?;
        }

        if !codex_app_is_installed()? {
            return Err(
                "Codex Desktop is not installed. Install the native Codex app, then launch Zero3 Pilot again."
                    .into(),
            );
        }

        install_codex_skill()?;
        let workspace = resolve_codex_workspace()?;
        open_codex_workspace(&workspace)?;

        // Native Codex now owns the visible desktop shell. Zero3 remains a
        // loopback-only sidecar so skills/plugins and background jobs can use it.
        node.persist();
        Ok(())
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

    fn resolve_codex_workspace() -> Result<PathBuf, Box<dyn std::error::Error>> {
        if let Some(path) = env::var_os("ZERO3_CODEX_WORKSPACE") {
            return validate_workspace(PathBuf::from(path));
        }
        if let Some(path) = env::args_os().nth(1) {
            return validate_workspace(PathBuf::from(path));
        }
        Ok(env::current_dir()?)
    }

    fn validate_workspace(path: PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
        if !path.is_dir() {
            return Err(format!("Codex workspace is not a directory: {}", path.display()).into());
        }
        Ok(path)
    }

    fn install_codex_skill() -> Result<(), Box<dyn std::error::Error>> {
        if matches!(
            env::var("ZERO3_DISABLE_CODEX_SKILL_SYNC").as_deref(),
            Ok("1" | "true" | "TRUE")
        ) {
            return Ok(());
        }

        let user_profile = env::var_os("USERPROFILE")
            .ok_or("USERPROFILE is unavailable; cannot install the Zero3 Codex skill")?;
        let skill_dir = PathBuf::from(user_profile)
            .join(".agents")
            .join("skills")
            .join("zero3-pilot");
        let skill_file = skill_dir.join("SKILL.md");

        if fs::read_to_string(&skill_file).as_deref() == Ok(ZERO3_CODEX_SKILL) {
            return Ok(());
        }

        fs::create_dir_all(&skill_dir)?;
        fs::write(skill_file, ZERO3_CODEX_SKILL)?;
        Ok(())
    }

    fn codex_app_is_installed() -> Result<bool, Box<dyn std::error::Error>> {
        // Keep the same stable package identity check used by the upstream
        // Codex CLI Windows desktop launcher.
        let output = powershell()
            .arg("-NoProfile")
            .arg("-Command")
            .arg(
                "Get-StartApps | Where-Object AppID -Like 'OpenAI.Codex_*!App' | Select-Object -First 1 -ExpandProperty AppID",
            )
            .output()?;
        if !output.status.success() {
            return Ok(false);
        }
        Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
    }

    fn open_codex_workspace(workspace: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let path = workspace.display().to_string();
        let url = codex_new_thread_url(&path);
        let status = powershell()
            .arg("-NoProfile")
            .arg("-Command")
            .arg("& { param($target) Start-Process -FilePath $target }")
            .arg(&url)
            .status()
            .map_err(|error| format!("failed to invoke Codex native shell: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to open Codex native shell with status {status}").into())
        }
    }

    fn powershell() -> Command {
        let mut command = Command::new("powershell.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn codex_new_thread_url(workspace: &str) -> String {
        format!(
            "codex://threads/new?path={}",
            percent_encode_query_value(workspace)
        )
    }

    fn percent_encode_query_value(value: &str) -> String {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        let mut encoded = String::with_capacity(value.len());
        for &byte in value.as_bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push('%');
                encoded.push(HEX[(byte >> 4) as usize] as char);
                encoded.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
        encoded
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

        #[test]
        fn codex_workspace_url_is_windows_safe() {
            assert_eq!(
                codex_new_thread_url(r"C:\Users\zero3\My Project"),
                "codex://threads/new?path=C%3A%5CUsers%5Czero3%5CMy%20Project"
            );
        }

        #[test]
        fn query_encoder_handles_utf8() {
            assert_eq!(percent_encode_query_value("零三"), "%E9%9B%B6%E4%B8%89");
        }
    }
}
