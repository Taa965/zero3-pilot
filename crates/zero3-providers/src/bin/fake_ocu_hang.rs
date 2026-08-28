//! Second test double: never reads stdin or writes stdout, just blocks —
//! used by `tests/open_computer_use.rs` to prove
//! `OpenComputerUseAdapter`'s timeout actually fires instead of hanging
//! forever on an unresponsive backend. Pure Rust so the behavior is
//! identical on every platform, unlike relying on a shell command.

fn main() {
    std::thread::sleep(std::time::Duration::from_secs(30));
}
