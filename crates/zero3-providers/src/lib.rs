//! Provider seams for real browser, computer-use and messaging backends.
//!
//! Concrete third-party transports stay behind Zero3-owned contracts so the
//! runtime can upgrade or replace an implementation without importing a
//! second agent runtime.

pub mod browser;
pub mod computer;
pub mod open_computer_use;
pub mod provider;
pub mod registry;
pub mod weixin_clawbot;

pub use provider::Provider;
pub use registry::ProviderRegistry;
