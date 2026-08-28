//! Test double speaking the *real* protocol confirmed against
//! `iFurySt/open-codex-computer-use` upstream source (see
//! `crates/zero3-providers/src/open_computer_use.rs`'s module docs):
//! standard MCP over stdio, one JSON-RPC 2.0 message per line —
//! `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
//! Used only by `tests/open_computer_use.rs` via
//! `env!("CARGO_BIN_EXE_fake_ocu")` — not a real backend.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("read a line from stdin");
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                write_line(
                    &mut stdout,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
                );
                continue;
            }
        };

        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");

        match method {
            "initialize" => write_line(
                &mut stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2025-03-26",
                        "serverInfo": {"name": "fake-open-computer-use", "version": "0.0.0"},
                        "capabilities": {"tools": {"listChanged": false}},
                    }
                }),
            ),
            "notifications/initialized" => {
                // Notification: no id, no response expected or sent.
            }
            "tools/list" => write_line(
                &mut stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": [
                            {"name": "get_app_state"},
                            {"name": "click"},
                            {"name": "type_text"},
                            {"name": "press_key"},
                        ]
                    }
                }),
            ),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                write_line(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{"type": "text", "text": "ok"}],
                            "isError": false,
                            "echoedArguments": params.get("arguments").cloned().unwrap_or(Value::Null),
                        }
                    }),
                );
            }
            other => write_line(
                &mut stdout,
                &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message": format!("Method not found: {other}")}}),
            ),
        }
    }
}

fn write_line(stdout: &mut io::Stdout, value: &Value) {
    writeln!(stdout, "{}", serde_json::to_string(value).unwrap()).unwrap();
    stdout.flush().unwrap();
}
