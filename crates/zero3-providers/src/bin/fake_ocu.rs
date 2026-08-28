//! Test double for an Open Computer Use backend: reads one line of JSON
//! (a `ComputerAction`) from stdin, writes one line of JSON (a
//! `ComputerActionResult`) to stdout. Used only by
//! `tests/open_computer_use.rs` via `env!("CARGO_BIN_EXE_fake_ocu")` — not
//! a real backend, and not shipped anywhere.

use std::io::{self, BufRead, Write};

use zero3_providers::computer::{ComputerAction, ComputerActionResult};

fn main() {
    let mut line = String::new();
    io::stdin()
        .lock()
        .read_line(&mut line)
        .expect("read one line of JSON from stdin");

    let result = match serde_json::from_str::<ComputerAction>(line.trim()) {
        Ok(action) => ComputerActionResult {
            ok: true,
            detail: serde_json::json!({ "received": action }),
        },
        Err(e) => ComputerActionResult {
            ok: false,
            detail: serde_json::json!({ "error": e.to_string() }),
        },
    };

    let mut stdout = io::stdout();
    writeln!(stdout, "{}", serde_json::to_string(&result).unwrap()).unwrap();
}
