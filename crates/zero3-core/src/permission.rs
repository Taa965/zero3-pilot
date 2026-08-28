//! Unified approval / policy layer. Every provider (computer, browser,
//! shell, filesystem, subagent) must route side-effecting actions through
//! this instead of enforcing its own ad-hoc rules.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionLevel {
    ReadOnly,
    Standard,
    Elevated,
    FullControl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRequest {
    pub actor: String,
    pub action: String,
    pub required_level: PermissionLevel,
    pub reversible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    Allow,
    Deny,
    RequireApproval,
}

/// A policy decides, given the caller's granted level and the action's
/// required level, whether to allow, deny, or escalate to a human approval.
/// Plugins/providers must call through this — they must not self-approve.
pub trait PolicyEngine: Send + Sync {
    fn evaluate(&self, granted: PermissionLevel, request: &ActionRequest) -> Decision;
}

pub struct DefaultPolicy;

impl PolicyEngine for DefaultPolicy {
    fn evaluate(&self, granted: PermissionLevel, request: &ActionRequest) -> Decision {
        if granted >= request.required_level {
            Decision::Allow
        } else if request.reversible {
            Decision::RequireApproval
        } else {
            Decision::Deny
        }
    }
}
