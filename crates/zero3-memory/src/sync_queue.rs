use std::{path::Path, sync::Mutex};

use anyhow::Context;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingState {
    Pending,
    Sending,
    Acked,
    Conflict,
    Rejected,
}

impl PendingState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Acked => "acked",
            Self::Conflict => "conflict",
            Self::Rejected => "rejected",
        }
    }

    fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "sending" => Ok(Self::Sending),
            "acked" => Ok(Self::Acked),
            "conflict" => Ok(Self::Conflict),
            "rejected" => Ok(Self::Rejected),
            other => anyhow::bail!("unknown pending memory state {other}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingMemoryEvent {
    pub event_id: String,
    pub payload: Value,
    pub state: PendingState,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub server_sequence: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCursor {
    pub client_id: String,
    pub device_id: String,
    pub last_sequence: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CachedServerEvent {
    pub sequence: i64,
    pub event_id: String,
    pub payload: Value,
    pub received_at: DateTime<Utc>,
}

pub struct SqliteSyncQueue {
    connection: Mutex<Connection>,
}

impl SqliteSyncQueue {
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        Self::from_connection(Connection::open(path).context("open memory sync SQLite database")?)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> anyhow::Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS pending_memory_events (
                event_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                state TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                server_sequence INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pending_memory_state
                ON pending_memory_events(state, created_at);

            CREATE TABLE IF NOT EXISTS memory_sync_state (
                client_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                last_sequence INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS server_memory_events (
                sequence INTEGER PRIMARY KEY,
                event_id TEXT NOT NULL UNIQUE,
                payload_json TEXT NOT NULL,
                received_at TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn enqueue(&self, event_id: &str, payload: &Value) -> anyhow::Result<bool> {
        let event_id = event_id.trim();
        if event_id.is_empty() {
            anyhow::bail!("event_id is required");
        }
        let payload_json = serde_json::to_string(payload)?;
        let now = Utc::now().to_rfc3339();
        let changed = self.connection.lock().unwrap().execute(
            "INSERT OR IGNORE INTO pending_memory_events
             (event_id, payload_json, state, retry_count, created_at, updated_at)
             VALUES (?1, ?2, 'pending', 0, ?3, ?3)",
            params![event_id, payload_json, now],
        )?;
        Ok(changed > 0)
    }

    pub fn next_batch(&self, limit: usize) -> anyhow::Result<Vec<PendingMemoryEvent>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT event_id, payload_json, state, retry_count, last_error, server_sequence, created_at, updated_at
             FROM pending_memory_events
             WHERE state = 'pending'
             ORDER BY created_at ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::try_from(limit)?], row_to_pending)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn mark_sending(&self, event_ids: &[String]) -> anyhow::Result<usize> {
        if event_ids.is_empty() {
            return Ok(0);
        }
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction()?;
        let mut changed = 0;
        for event_id in event_ids {
            changed += transaction.execute(
                "UPDATE pending_memory_events
                 SET state = 'sending', retry_count = retry_count + 1, updated_at = ?2
                 WHERE event_id = ?1 AND state = 'pending'",
                params![event_id, now],
            )?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    pub fn mark_acked(&self, event_id: &str, sequence: i64) -> anyhow::Result<bool> {
        if sequence < 1 {
            anyhow::bail!("server sequence must be positive");
        }
        let now = Utc::now().to_rfc3339();
        Ok(self.connection.lock().unwrap().execute(
            "UPDATE pending_memory_events
             SET state = 'acked', server_sequence = ?2, last_error = NULL, updated_at = ?3
             WHERE event_id = ?1",
            params![event_id, sequence, now],
        )? > 0)
    }

    pub fn mark_conflict(&self, event_id: &str, error: &str) -> anyhow::Result<bool> {
        self.mark_terminal(event_id, PendingState::Conflict, error)
    }

    pub fn mark_rejected(&self, event_id: &str, error: &str) -> anyhow::Result<bool> {
        self.mark_terminal(event_id, PendingState::Rejected, error)
    }

    fn mark_terminal(
        &self,
        event_id: &str,
        state: PendingState,
        error: &str,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        Ok(self.connection.lock().unwrap().execute(
            "UPDATE pending_memory_events SET state = ?2, last_error = ?3, updated_at = ?4 WHERE event_id = ?1",
            params![event_id, state.as_str(), error, now],
        )? > 0)
    }

    pub fn reset_inflight(&self) -> anyhow::Result<usize> {
        let now = Utc::now().to_rfc3339();
        Ok(self.connection.lock().unwrap().execute(
            "UPDATE pending_memory_events SET state = 'pending', updated_at = ?1 WHERE state = 'sending'",
            [now],
        )?)
    }

    pub fn pending_count(&self) -> anyhow::Result<usize> {
        let count: i64 = self.connection.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM pending_memory_events WHERE state IN ('pending','sending')",
            [],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count)?)
    }

    pub fn get_pending(&self, event_id: &str) -> anyhow::Result<Option<PendingMemoryEvent>> {
        self.connection.lock().unwrap().query_row(
            "SELECT event_id, payload_json, state, retry_count, last_error, server_sequence, created_at, updated_at
             FROM pending_memory_events WHERE event_id = ?1",
            [event_id],
            row_to_pending,
        ).optional().map_err(Into::into)
    }

    pub fn upsert_cursor(
        &self,
        client_id: &str,
        device_id: &str,
        last_sequence: i64,
    ) -> anyhow::Result<()> {
        if client_id.trim().is_empty() || device_id.trim().is_empty() || last_sequence < 0 {
            anyhow::bail!("invalid sync cursor");
        }
        let now = Utc::now().to_rfc3339();
        self.connection.lock().unwrap().execute(
            "INSERT INTO memory_sync_state (client_id, device_id, last_sequence, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(client_id) DO UPDATE SET
               device_id=excluded.device_id,
               last_sequence=MAX(memory_sync_state.last_sequence, excluded.last_sequence),
               updated_at=excluded.updated_at",
            params![client_id, device_id, last_sequence, now],
        )?;
        Ok(())
    }

    pub fn get_cursor(&self, client_id: &str) -> anyhow::Result<Option<SyncCursor>> {
        self.connection.lock().unwrap().query_row(
            "SELECT client_id, device_id, last_sequence, updated_at FROM memory_sync_state WHERE client_id = ?1",
            [client_id],
            |row| {
                let updated_at: String = row.get(3)?;
                Ok(SyncCursor {
                    client_id: row.get(0)?, device_id: row.get(1)?, last_sequence: row.get(2)?,
                    updated_at: parse_datetime(3, &updated_at)?,
                })
            },
        ).optional().map_err(Into::into)
    }

    pub fn cache_server_event(
        &self,
        sequence: i64,
        event_id: &str,
        payload: &Value,
    ) -> anyhow::Result<bool> {
        if sequence < 1 || event_id.trim().is_empty() {
            anyhow::bail!("invalid server event");
        }
        let payload_json = serde_json::to_string(payload)?;
        let now = Utc::now().to_rfc3339();
        let changed = self.connection.lock().unwrap().execute(
            "INSERT OR IGNORE INTO server_memory_events (sequence, event_id, payload_json, received_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![sequence, event_id, payload_json, now],
        )?;
        Ok(changed > 0)
    }

    pub fn cached_events_after(
        &self,
        sequence: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<CachedServerEvent>> {
        if sequence < 0 || limit == 0 {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT sequence, event_id, payload_json, received_at FROM server_memory_events
             WHERE sequence > ?1 ORDER BY sequence ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![sequence, i64::try_from(limit)?], |row| {
            let payload_json: String = row.get(2)?;
            let received_at: String = row.get(3)?;
            Ok(CachedServerEvent {
                sequence: row.get(0)?,
                event_id: row.get(1)?,
                payload: serde_json::from_str(&payload_json)
                    .map_err(|error| convert_error(2, error))?,
                received_at: parse_datetime(3, &received_at)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

fn row_to_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingMemoryEvent> {
    let payload_json: String = row.get(1)?;
    let state: String = row.get(2)?;
    let retry_count: i64 = row.get(3)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    Ok(PendingMemoryEvent {
        event_id: row.get(0)?,
        payload: serde_json::from_str(&payload_json).map_err(|error| convert_error(1, error))?,
        state: PendingState::parse(&state).map_err(|error| convert_boxed(2, Box::new(error)))?,
        retry_count: u32::try_from(retry_count)
            .map_err(|error| convert_boxed(3, Box::new(error)))?,
        last_error: row.get(4)?,
        server_sequence: row.get(5)?,
        created_at: parse_datetime(6, &created_at)?,
        updated_at: parse_datetime(7, &updated_at)?,
    })
}

fn parse_datetime(index: usize, value: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| convert_boxed(index, Box::new(error)))
}

fn convert_error(index: usize, error: serde_json::Error) -> rusqlite::Error {
    convert_boxed(index, Box::new(error))
}

fn convert_boxed(index: usize, error: Box<dyn std::error::Error + Send + Sync>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enqueue_is_idempotent_and_crash_recovery_resets_sending() {
        let queue = SqliteSyncQueue::open_in_memory().unwrap();
        assert!(queue
            .enqueue("evt-1", &json!({"event_id":"evt-1"}))
            .unwrap());
        assert!(!queue
            .enqueue("evt-1", &json!({"event_id":"evt-1"}))
            .unwrap());
        let batch = queue.next_batch(10).unwrap();
        assert_eq!(batch.len(), 1);
        queue.mark_sending(&["evt-1".into()]).unwrap();
        assert_eq!(queue.next_batch(10).unwrap().len(), 0);
        assert_eq!(queue.reset_inflight().unwrap(), 1);
        assert_eq!(queue.next_batch(10).unwrap().len(), 1);
    }

    #[test]
    fn cursor_is_monotonic_and_server_event_cache_deduplicates() {
        let queue = SqliteSyncQueue::open_in_memory().unwrap();
        queue.upsert_cursor("client", "device", 10).unwrap();
        queue.upsert_cursor("client", "device", 7).unwrap();
        assert_eq!(
            queue.get_cursor("client").unwrap().unwrap().last_sequence,
            10
        );
        assert!(queue
            .cache_server_event(11, "evt-11", &json!({"v":11}))
            .unwrap());
        assert!(!queue
            .cache_server_event(11, "evt-11", &json!({"v":11}))
            .unwrap());
        assert_eq!(queue.cached_events_after(10, 10).unwrap().len(), 1);
    }

    #[test]
    fn conflicts_are_materialized_instead_of_silently_retried() {
        let queue = SqliteSyncQueue::open_in_memory().unwrap();
        queue
            .enqueue("evt-conflict", &json!({"event_id":"evt-conflict"}))
            .unwrap();
        queue
            .mark_conflict("evt-conflict", "authority_conflict")
            .unwrap();
        let item = queue.get_pending("evt-conflict").unwrap().unwrap();
        assert_eq!(item.state, PendingState::Conflict);
        assert_eq!(item.last_error.as_deref(), Some("authority_conflict"));
        assert_eq!(queue.pending_count().unwrap(), 0);
    }
}
