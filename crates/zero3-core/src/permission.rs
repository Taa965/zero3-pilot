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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(required_level: PermissionLevel, reversible: bool) -> ActionRequest {
        ActionRequest {
            actor: "test-provider".into(),
            action: "do-thing".into(),
            required_level,
            reversible,
        }
    }

    #[test]
    fn sufficient_grant_always_allows_regardless_of_reversibility() {
        let policy = DefaultPolicy;
        assert_eq!(
            policy.evaluate(
                PermissionLevel::Standard,
                &request(PermissionLevel::Standard, false)
            ),
            Decision::Allow
        );
        assert_eq!(
            policy.evaluate(
                PermissionLevel::FullControl,
                &request(PermissionLevel::Elevated, true)
            ),
            Decision::Allow
        );
    }

    #[test]
    fn insufficient_grant_on_irreversible_action_is_denied_not_escalated() {
        // A provider must never be able to talk its way into an
        // irreversible action just by asking — an under-privileged caller
        // is flatly denied, not offered an approval path.
        let policy = DefaultPolicy;
        let decision = policy.evaluate(
            PermissionLevel::ReadOnly,
            &request(PermissionLevel::Elevated, false),
        );
        assert_eq!(decision, Decision::Deny);
    }

    #[test]
    fn insufficient_grant_on_reversible_action_requires_approval_not_silent_allow() {
        // Under-privileged + reversible must escalate to a human, never
        // silently proceed — this is the seam a provider is not allowed
        // to bypass by self-approving.
        let policy = DefaultPolicy;
        let decision = policy.evaluate(
            PermissionLevel::ReadOnly,
            &request(PermissionLevel::Standard, true),
        );
        assert_eq!(decision, Decision::RequireApproval);
    }

    #[test]
    fn permission_levels_form_the_expected_strict_order() {
        assert!(PermissionLevel::ReadOnly < PermissionLevel::Standard);
        assert!(PermissionLevel::Standard < PermissionLevel::Elevated);
        assert!(PermissionLevel::Elevated < PermissionLevel::FullControl);
    }
}
