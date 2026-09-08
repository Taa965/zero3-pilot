use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Context;
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthGrantConfig {
    token: String,
    client_id: String,
    #[serde(default)]
    projects: Vec<String>,
    #[serde(default)]
    agent_types: Vec<String>,
    max_authority: u8,
    #[serde(default)]
    allow_global: bool,
    #[serde(default)]
    allow_personal: bool,
}

#[derive(Debug, Clone)]
pub struct AuthGrant {
    pub client_id: Arc<str>,
    projects: Arc<HashSet<String>>,
    agent_types: Arc<HashSet<String>>,
    pub max_authority: u8,
    pub allow_global: bool,
    pub allow_personal: bool,
}

impl AuthGrant {
    pub fn allows_project(&self, project_id: &str) -> bool {
        self.projects.contains("*") || self.projects.contains(project_id)
    }

    pub fn allows_agent_type(&self, agent_type: &str) -> bool {
        self.agent_types.contains(agent_type)
    }

    pub fn authorize_event(
        &self,
        project_id: Option<&str>,
        memory_class: &str,
        agent_type: &str,
        authority: u8,
    ) -> Result<(), AuthFailure> {
        if !self.allows_agent_type(agent_type) {
            return Err(AuthFailure::forbidden("agent_type_denied"));
        }
        if authority > self.max_authority {
            return Err(AuthFailure::forbidden("authority_denied"));
        }
        if memory_class == "personal" && !self.allow_personal {
            return Err(AuthFailure::forbidden("personal_denied"));
        }
        if memory_class == "global" {
            if !self.allow_global {
                return Err(AuthFailure::forbidden("global_denied"));
            }
            return Ok(());
        }
        let project_id = project_id.ok_or_else(|| AuthFailure::forbidden("project_required"))?;
        if !self.allows_project(project_id) {
            return Err(AuthFailure::forbidden("project_denied"));
        }
        Ok(())
    }

    pub fn authorize_projects(&self, projects: &[String]) -> Result<(), AuthFailure> {
        if projects.iter().any(|project| !self.allows_project(project)) {
            return Err(AuthFailure::forbidden("project_denied"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct AuthPolicy {
    grants: Arc<HashMap<String, AuthGrant>>,
}

impl AuthPolicy {
    pub fn from_json(value: &str) -> anyhow::Result<Self> {
        let configs: Vec<AuthGrantConfig> =
            serde_json::from_str(value).context("parse memory auth JSON")?;
        if configs.is_empty() {
            anyhow::bail!("memory auth policy must contain at least one grant");
        }
        let mut grants = HashMap::new();
        let mut client_ids = HashSet::new();
        for config in configs {
            let token = config.token.trim().to_owned();
            let client_id = config.client_id.trim().to_owned();
            if token.len() < 24 {
                anyhow::bail!("memory bearer tokens must be at least 24 characters");
            }
            if client_id.is_empty() {
                anyhow::bail!("memory auth client_id must be non-empty");
            }
            if config.max_authority > 100 {
                anyhow::bail!("memory auth max_authority must be <= 100");
            }
            if config.agent_types.is_empty() {
                anyhow::bail!("memory auth grant must allow at least one agent_type");
            }
            if !client_ids.insert(client_id.clone()) {
                anyhow::bail!("duplicate memory auth client_id");
            }
            let grant = AuthGrant {
                client_id: Arc::from(client_id),
                projects: Arc::new(config.projects.into_iter().collect()),
                agent_types: Arc::new(config.agent_types.into_iter().collect()),
                max_authority: config.max_authority,
                allow_global: config.allow_global,
                allow_personal: config.allow_personal,
            };
            if grants.insert(token, grant).is_some() {
                anyhow::bail!("duplicate memory bearer token");
            }
        }
        Ok(Self {
            grants: Arc::new(grants),
        })
    }

    pub fn authenticate(&self, headers: &HeaderMap) -> Result<AuthGrant, AuthFailure> {
        let value = headers
            .get(AUTHORIZATION)
            .ok_or_else(|| AuthFailure::unauthorized("missing_bearer_token"))?
            .to_str()
            .map_err(|_| AuthFailure::unauthorized("invalid_bearer_token"))?;
        let token = value
            .strip_prefix("Bearer ")
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AuthFailure::unauthorized("invalid_bearer_token"))?;
        self.grants
            .get(token)
            .cloned()
            .ok_or_else(|| AuthFailure::unauthorized("invalid_bearer_token"))
    }
}

#[derive(Debug, Clone)]
pub struct AuthFailure {
    pub status: StatusCode,
    pub code: &'static str,
}

impl AuthFailure {
    fn unauthorized(code: &'static str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code,
        }
    }

    fn forbidden(code: &'static str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn policy() -> AuthPolicy {
        AuthPolicy::from_json(
            r#"[{
          "token":"abcdefghijklmnopqrstuvwxyz123456",
          "client_id":"pilot-test",
          "projects":["project-a"],
          "agent_types":["codex","claude"],
          "max_authority":60,
          "allow_global":false,
          "allow_personal":false
        }]"#,
        )
        .unwrap()
    }

    #[test]
    fn bearer_auth_and_acl_are_fail_closed() {
        let policy = policy();
        let mut headers = HeaderMap::new();
        assert_eq!(
            policy.authenticate(&headers).unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer abcdefghijklmnopqrstuvwxyz123456"),
        );
        let grant = policy.authenticate(&headers).unwrap();
        assert_eq!(&*grant.client_id, "pilot-test");
        assert!(grant
            .authorize_event(Some("project-a"), "project", "codex", 60)
            .is_ok());
        assert_eq!(
            grant
                .authorize_event(Some("project-b"), "project", "codex", 60)
                .unwrap_err()
                .code,
            "project_denied"
        );
        assert_eq!(
            grant
                .authorize_event(Some("project-a"), "project", "system", 60)
                .unwrap_err()
                .code,
            "agent_type_denied"
        );
        assert_eq!(
            grant
                .authorize_event(Some("project-a"), "project", "codex", 85)
                .unwrap_err()
                .code,
            "authority_denied"
        );
        assert_eq!(
            grant
                .authorize_event(Some("project-a"), "personal", "codex", 20)
                .unwrap_err()
                .code,
            "personal_denied"
        );
    }
}
