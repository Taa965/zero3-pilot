//! Persistent local scheduler backed by SQLite.
//!
//! The scheduler never executes work itself. It only persists schedule
//! definitions, finds due occurrences, and enqueues them into `JobManager`.
//! Each enqueued payload carries a stable schedule id and scheduled timestamp
//! so downstream executors can audit/deduplicate at-least-once delivery.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, NaiveTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::JobManager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleSpec {
    Once,
    EverySeconds { seconds: u64 },
    DailyUtc { hour: u8, minute: u8 },
}

impl ScheduleSpec {
    pub fn validate(&self) -> anyhow::Result<()> {
        match self {
            Self::Once => Ok(()),
            Self::EverySeconds { seconds } if *seconds > 0 => Ok(()),
            Self::EverySeconds { .. } => Err(anyhow!("every_seconds requires seconds > 0")),
            Self::DailyUtc { hour, minute } if *hour < 24 && *minute < 60 => Ok(()),
            Self::DailyUtc { .. } => Err(anyhow!("daily_utc requires hour < 24 and minute < 60")),
        }
    }

    fn next_after(&self, previous: DateTime<Utc>) -> anyhow::Result<Option<DateTime<Utc>>> {
        self.validate()?;
        match self {
            Self::Once => Ok(None),
            Self::EverySeconds { seconds } => Ok(Some(
                previous + ChronoDuration::seconds(i64::try_from(*seconds).unwrap_or(i64::MAX)),
            )),
            Self::DailyUtc { hour, minute } => {
                let time = NaiveTime::from_hms_opt(u32::from(*hour), u32::from(*minute), 0)
                    .ok_or_else(|| anyhow!("invalid daily UTC time"))?;
                let next_date = previous
                    .date_naive()
                    .succ_opt()
                    .ok_or_else(|| anyhow!("daily schedule date overflow"))?;
                let naive = NaiveDateTime::new(next_date, time);
                Ok(Some(DateTime::from_naive_utc_and_offset(naive, Utc)))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScheduledTask {
    pub id: Uuid,
    pub job_kind: String,
    pub payload: Value,
    pub schedule: ScheduleSpec,
    pub next_run_at: Option<DateTime<Utc>>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct PersistentScheduler {
    connection: Mutex<Connection>,
}

impl PersistentScheduler {
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let connection = Connection::open(path).context("open scheduler SQLite database")?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> anyhow::Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY NOT NULL,
                job_kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                schedule_json TEXT NOT NULL,
                next_run_at TEXT,
                enabled INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_schedules_due
                ON schedules(enabled, next_run_at);
            ",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn schedule(
        &self,
        job_kind: impl Into<String>,
        payload: Value,
        schedule: ScheduleSpec,
        first_run_at: DateTime<Utc>,
    ) -> anyhow::Result<Uuid> {
        schedule.validate()?;
        let id = Uuid::new_v4();
        let now = Utc::now();
        let job_kind = job_kind.into();
        if job_kind.trim().is_empty() {
            return Err(anyhow!("scheduled job kind must not be empty"));
        }
        let payload_json = serde_json::to_string(&payload)?;
        let schedule_json = serde_json::to_string(&schedule)?;
        self.connection.lock().unwrap().execute(
            "INSERT INTO schedules
             (id, job_kind, payload_json, schedule_json, next_run_at, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
            params![
                id.to_string(),
                job_kind,
                payload_json,
                schedule_json,
                first_run_at.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;
        Ok(id)
    }

    pub fn get(&self, id: Uuid) -> anyhow::Result<Option<ScheduledTask>> {
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, job_kind, payload_json, schedule_json, next_run_at,
                        enabled, created_at, updated_at
                 FROM schedules WHERE id = ?1",
                [id.to_string()],
                row_to_task,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list(&self) -> anyhow::Result<Vec<ScheduledTask>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id, job_kind, payload_json, schedule_json, next_run_at,
                    enabled, created_at, updated_at
             FROM schedules ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([], row_to_task)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn due(&self, now: DateTime<Utc>) -> anyhow::Result<Vec<ScheduledTask>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id, job_kind, payload_json, schedule_json, next_run_at,
                    enabled, created_at, updated_at
             FROM schedules
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
             ORDER BY next_run_at, id",
        )?;
        let rows = statement.query_map([now.to_rfc3339()], row_to_task)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_enabled(&self, id: Uuid, enabled: bool) -> anyhow::Result<bool> {
        let changed = self.connection.lock().unwrap().execute(
            "UPDATE schedules SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), i64::from(enabled), Utc::now().to_rfc3339()],
        )?;
        Ok(changed > 0)
    }

    pub fn delete(&self, id: Uuid) -> anyhow::Result<bool> {
        Ok(self
            .connection
            .lock()
            .unwrap()
            .execute("DELETE FROM schedules WHERE id = ?1", [id.to_string()])?
            > 0)
    }

    /// Enqueue every currently due occurrence. Delivery is intentionally
    /// at-least-once across a process crash that happens after JobManager has
    /// durably accepted a job but before this SQLite row advances. The emitted
    /// `schedule_id` + `scheduled_for` pair is the stable downstream dedupe key.
    pub fn dispatch_due(
        &self,
        jobs: &JobManager,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<Uuid>> {
        let due = self.due(now)?;
        let mut created = Vec::with_capacity(due.len());
        for task in due {
            let scheduled_for = task
                .next_run_at
                .ok_or_else(|| anyhow!("due task {} has no next_run_at", task.id))?;
            let envelope = json!({
                "schedule_id": task.id,
                "scheduled_for": scheduled_for,
                "payload": task.payload,
            });
            let job_id = jobs
                .create(task.job_kind.clone(), envelope, None)
                .context("enqueue scheduled job")?;
            self.advance_after_dispatch(&task, scheduled_for)?;
            created.push(job_id);
        }
        Ok(created)
    }

    fn advance_after_dispatch(
        &self,
        task: &ScheduledTask,
        scheduled_for: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let next = task.schedule.next_after(scheduled_for)?;
        let enabled = next.is_some();
        self.connection.lock().unwrap().execute(
            "UPDATE schedules
             SET next_run_at = ?2, enabled = ?3, updated_at = ?4
             WHERE id = ?1",
            params![
                task.id.to_string(),
                next.map(|value| value.to_rfc3339()),
                i64::from(enabled),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledTask> {
    let id: String = row.get(0)?;
    let payload_json: String = row.get(2)?;
    let schedule_json: String = row.get(3)?;
    let next_run_at: Option<String> = row.get(4)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;

    let parse_error = |index: usize, error: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error)
    };

    Ok(ScheduledTask {
        id: Uuid::parse_str(&id).map_err(|error| parse_error(0, Box::new(error)))?,
        job_kind: row.get(1)?,
        payload: serde_json::from_str(&payload_json)
            .map_err(|error| parse_error(2, Box::new(error)))?,
        schedule: serde_json::from_str(&schedule_json)
            .map_err(|error| parse_error(3, Box::new(error)))?,
        next_run_at: next_run_at
            .map(|value| {
                DateTime::parse_from_rfc3339(&value)
                    .map(|value| value.with_timezone(&Utc))
                    .map_err(|error| parse_error(4, Box::new(error)))
            })
            .transpose()?,
        enabled: row.get::<_, i64>(5)? != 0,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| parse_error(6, Box::new(error)))?,
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| parse_error(7, Box::new(error)))?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::TimeZone;
    use tempfile::tempdir;
    use zero3_store::EventStore;

    use super::*;

    #[test]
    fn recurring_schedule_survives_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("scheduler.sqlite");
        let first = Utc.with_ymd_and_hms(2026, 8, 29, 1, 0, 0).unwrap();
        let id = {
            let scheduler = PersistentScheduler::open(&path).unwrap();
            scheduler
                .schedule(
                    "brief",
                    json!({"topic":"ai"}),
                    ScheduleSpec::EverySeconds { seconds: 3600 },
                    first,
                )
                .unwrap()
        };
        let reopened = PersistentScheduler::open(&path).unwrap();
        let task = reopened.get(id).unwrap().unwrap();
        assert_eq!(task.next_run_at, Some(first));
        assert_eq!(task.schedule, ScheduleSpec::EverySeconds { seconds: 3600 });
    }

    #[test]
    fn once_schedule_dispatches_one_job_then_disables() {
        let dir = tempdir().unwrap();
        let scheduler = PersistentScheduler::open(dir.path().join("scheduler.sqlite")).unwrap();
        let event_store = Arc::new(EventStore::open(dir.path().join("events.jsonl")).unwrap());
        let jobs = JobManager::new(event_store);
        let due_at = Utc.with_ymd_and_hms(2026, 8, 29, 2, 0, 0).unwrap();
        let schedule_id = scheduler
            .schedule("automation", json!({"x":1}), ScheduleSpec::Once, due_at)
            .unwrap();

        let created = scheduler.dispatch_due(&jobs, due_at).unwrap();
        assert_eq!(created.len(), 1);
        let task = scheduler.get(schedule_id).unwrap().unwrap();
        assert!(!task.enabled);
        assert!(task.next_run_at.is_none());
        assert!(scheduler.dispatch_due(&jobs, due_at).unwrap().is_empty());
    }

    #[test]
    fn interval_schedule_advances_from_scheduled_time() {
        let scheduler = PersistentScheduler::open_in_memory().unwrap();
        let first = Utc.with_ymd_and_hms(2026, 8, 29, 3, 0, 0).unwrap();
        let id = scheduler
            .schedule(
                "poll",
                json!({}),
                ScheduleSpec::EverySeconds { seconds: 60 },
                first,
            )
            .unwrap();
        let dir = tempdir().unwrap();
        let jobs = JobManager::new(Arc::new(
            EventStore::open(dir.path().join("events.jsonl")).unwrap(),
        ));
        scheduler.dispatch_due(&jobs, first).unwrap();
        assert_eq!(
            scheduler.get(id).unwrap().unwrap().next_run_at,
            Some(first + ChronoDuration::seconds(60))
        );
    }
}
