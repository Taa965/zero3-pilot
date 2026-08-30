use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::control_plane::{RemoteTask, REMOTE_TASK_PROTOCOL};

pub const MAX_REMOTE_CONTROL_BODY_BYTES: usize = 2 * 1024 * 1024;

pub async fn validate_control_task_admission(
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.method() != Method::POST || request.uri().path() != "/api/control/v1/tasks" {
        return next.run(request).await;
    }

    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, MAX_REMOTE_CONTROL_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "remote task request exceeds the 2 MiB limit"),
    };
    let task: RemoteTask = match serde_json::from_slice(&bytes) {
        Ok(task) => task,
        Err(_) => return error(StatusCode::BAD_REQUEST, "remote task request must be valid JSON matching the v1 schema"),
    };
    if let Err(message) = validate_remote_task(&task) {
        return error(StatusCode::BAD_REQUEST, message);
    }

    next.run(Request::from_parts(parts, Body::from(bytes))).await
}

fn validate_remote_task(task: &RemoteTask) -> Result<(), &'static str> {
    if task.protocol != REMOTE_TASK_PROTOCOL {
        return Err("unsupported Zero3 remote task protocol");
    }
    validate_text(&task.task_id, 128, "task_id is required and must be at most 128 characters")?;
    validate_text(
        &task.execution_id,
        128,
        "execution_id is required and must be at most 128 characters",
    )?;
    validate_text(
        &task.objective,
        64_000,
        "objective is required and must be at most 64000 characters",
    )?;
    validate_text(
        &task.target.workspace,
        4096,
        "target.workspace is required and must be at most 4096 characters",
    )?;
    if let Some(base_ref) = &task.target.base_ref {
        validate_text(base_ref, 256, "target.base_ref must be at most 256 characters")?;
    }
    validate_list(task.constraints.as_deref(), "constraints")?;
    validate_list(task.acceptance_criteria.as_deref(), "acceptance_criteria")?;

    let permission = task.permission_profile.as_deref().unwrap_or("standard");
    if !matches!(permission, "read_only" | "standard" | "elevated" | "full_control") {
        return Err("unsupported remote permission_profile");
    }

    if let Some(execution) = &task.execution {
        if let Some(max_turns) = execution.max_turns {
            if !(1..=32).contains(&max_turns) {
                return Err("execution.max_turns must be an integer from 1 to 32");
            }
        }
        if let Some(timeout_seconds) = execution.timeout_seconds {
            if !(30..=28_800).contains(&timeout_seconds) {
                return Err("execution.timeout_seconds must be an integer from 30 to 28800");
            }
        }
    }
    Ok(())
}

fn validate_text<'a>(value: &'a str, max: usize, message: &'static str) -> Result<&'a str, &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max {
        return Err(message);
    }
    Ok(trimmed)
}

fn validate_list(values: Option<&[String]>, label: &'static str) -> Result<(), &'static str> {
    let Some(values) = values else {
        return Ok(());
    };
    if values.len() > 64 {
        return Err(match label {
            "constraints" => "constraints must contain at most 64 items",
            _ => "acceptance_criteria must contain at most 64 items",
        });
    }
    for value in values {
        if value.trim().is_empty() || value.len() > 4096 {
            return Err(match label {
                "constraints" => "each constraints item must be non-empty and at most 4096 characters",
                _ => "each acceptance_criteria item must be non-empty and at most 4096 characters",
            });
        }
    }
    Ok(())
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::{RemoteTaskExecution, RemoteTaskTarget};

    fn valid_task() -> RemoteTask {
        RemoteTask {
            protocol: REMOTE_TASK_PROTOCOL.to_string(),
            task_id: "task-admission".into(),
            execution_id: "exec-admission".into(),
            objective: "validate admission".into(),
            target: RemoteTaskTarget {
                workspace: r"C:\workspace".into(),
                base_ref: None,
            },
            constraints: None,
            acceptance_criteria: None,
            permission_profile: Some("read_only".into()),
            execution: Some(RemoteTaskExecution {
                max_turns: Some(1),
                timeout_seconds: Some(3600),
                require_clean_worktree: Some(false),
            }),
        }
    }

    #[test]
    fn admission_matches_host_permission_and_execution_ranges() {
        assert!(validate_remote_task(&valid_task()).is_ok());

        let mut invalid_permission = valid_task();
        invalid_permission.permission_profile = Some("god_mode".into());
        assert_eq!(
            validate_remote_task(&invalid_permission),
            Err("unsupported remote permission_profile")
        );

        let mut invalid_turns = valid_task();
        invalid_turns.execution.as_mut().unwrap().max_turns = Some(33);
        assert_eq!(
            validate_remote_task(&invalid_turns),
            Err("execution.max_turns must be an integer from 1 to 32")
        );

        let mut invalid_timeout = valid_task();
        invalid_timeout.execution.as_mut().unwrap().timeout_seconds = Some(29);
        assert_eq!(
            validate_remote_task(&invalid_timeout),
            Err("execution.timeout_seconds must be an integer from 30 to 28800")
        );
    }

    #[test]
    fn admission_rejects_host_invalid_text_and_list_shapes() {
        let mut empty_objective = valid_task();
        empty_objective.objective = "   ".into();
        assert!(validate_remote_task(&empty_objective).is_err());

        let mut too_many_constraints = valid_task();
        too_many_constraints.constraints = Some((0..65).map(|i| format!("constraint-{i}")).collect());
        assert_eq!(
            validate_remote_task(&too_many_constraints),
            Err("constraints must contain at most 64 items")
        );
    }
}
