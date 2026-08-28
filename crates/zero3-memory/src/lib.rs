//! Policy-governed memory persistence for Zero3 Pilot.
//!
//! Operational state may be recorded by the runtime. Personal memory requires
//! an explicit approval bit at the storage boundary; callers cannot silently
//! promote an observation into long-term personal memory.

use std::path::Path;
use std::sync::Mutex;

use anyhow::Context;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryClass {
    Operational,
    Personal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoryScope {
    Global,
    Session { session_id: String },
    Thread { thread_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryRecord {
    pub key: String,
    pub value: Value,
    pub class: MemoryClass,
    pub scope: MemoryScope,
    pub source: String,
    pub approved: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl MemoryRecord {
    pub fn operational(
        key: impl Into<String>,
        value: Value,
        scope: MemoryScope,
        source: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            key: key.into(),
            value,
            class: MemoryClass::Operational,
            scope,
            source: source.into(),
            approved: true,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn personal(
        key: impl Into<String>,
        value: Value,
        scope: MemoryScope,
        source: impl Into<String>,
        approved: bool,
    ) -> Self {
        let now = Utc::now();
        Self {
            key: key.into(),
            value,
            class: MemoryClass::Personal,
            scope,
            source: source.into(),
            approved,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("personal memory '{key}' requires explicit approval")]
    PersonalApprovalRequired { key: String },
    #[error("memory key must not be empty")]
    EmptyKey,
}

pub trait MemoryStore: Send + Sync {
    fn get(&self, key: &str, scope: &MemoryScope) -> anyhow::Result<Option<MemoryRecord>>;
    fn put(&self, record: MemoryRecord) -> anyhow::Result<()>;
    fn delete(&self, key: &str, scope: &MemoryScope) -> anyhow::Result<bool>;
    fn list(&self, scope: Option<&MemoryScope>) -> anyhow::Result<Vec<MemoryRecord>>;
    fn search(&self, query: &str, scope: Option<&MemoryScope>)
        -> anyhow::Result<Vec<MemoryRecord>>;
}

pub struct SqliteMemoryStore {
    connection: Mutex<Connection>,
}

impl SqliteMemoryStore {
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        Self::from_connection(Connection::open(path).context("open memory SQLite database")?)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> anyhow::Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS memory_records (
                key TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                class TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                source TEXT NOT NULL,
                approved INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(key, scope_key)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope_key);
            CREATE INDEX IF NOT EXISTS idx_memory_class ON memory_records(class);
            ",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn validate(record: &MemoryRecord) -> Result<(), MemoryError> {
        if record.key.trim().is_empty() {
            return Err(MemoryError::EmptyKey);
        }
        if record.class == MemoryClass::Personal && !record.approved {
            return Err(MemoryError::PersonalApprovalRequired {
                key: record.key.clone(),
            });
        }
        Ok(())
    }
}

impl MemoryStore for SqliteMemoryStore {
    fn get(&self, key: &str, scope: &MemoryScope) -> anyhow::Result<Option<MemoryRecord>> {
        let scope_key = scope_key(scope)?;
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT key, value_json, class, scope_json, source, approved, created_at, updated_at
                 FROM memory_records WHERE key = ?1 AND scope_key = ?2",
                params![key, scope_key],
                row_to_record,
            )
            .optional()
            .map_err(Into::into)
    }

    fn put(&self, mut record: MemoryRecord) -> anyhow::Result<()> {
        Self::validate(&record)?;
        let now = Utc::now();
        let scope_key = scope_key(&record.scope)?;
        let scope_json = serde_json::to_string(&record.scope)?;
        let value_json = serde_json::to_string(&record.value)?;
        let class = match record.class {
            MemoryClass::Operational => "operational",
            MemoryClass::Personal => "personal",
        };

        let existing_created_at: Option<String> = self
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT created_at FROM memory_records WHERE key = ?1 AND scope_key = ?2",
                params![record.key, scope_key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(created_at) = existing_created_at {
            record.created_at = DateTime::parse_from_rfc3339(&created_at)?.with_timezone(&Utc);
        }
        record.updated_at = now;

        self.connection.lock().unwrap().execute(
            "INSERT INTO memory_records
             (key, scope_key, value_json, class, scope_json, source, approved, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(key, scope_key) DO UPDATE SET
               value_json=excluded.value_json,
               class=excluded.class,
               scope_json=excluded.scope_json,
               source=excluded.source,
               approved=excluded.approved,
               updated_at=excluded.updated_at",
            params![
                record.key,
                scope_key,
                value_json,
                class,
                scope_json,
                record.source,
                i64::from(record.approved),
                record.created_at.to_rfc3339(),
                record.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    fn delete(&self, key: &str, scope: &MemoryScope) -> anyhow::Result<bool> {
        let scope_key = scope_key(scope)?;
        Ok(self.connection.lock().unwrap().execute(
            "DELETE FROM memory_records WHERE key = ?1 AND scope_key = ?2",
            params![key, scope_key],
        )? > 0)
    }

    fn list(&self, scope: Option<&MemoryScope>) -> anyhow::Result<Vec<MemoryRecord>> {
        query_records(&self.connection, None, scope)
    }

    fn search(
        &self,
        query: &str,
        scope: Option<&MemoryScope>,
    ) -> anyhow::Result<Vec<MemoryRecord>> {
        query_records(&self.connection, Some(query), scope)
    }
}

fn scope_key(scope: &MemoryScope) -> anyhow::Result<String> {
    Ok(match scope {
        MemoryScope::Global => "global".into(),
        MemoryScope::Session { session_id } => format!("session:{session_id}"),
        MemoryScope::Thread { thread_id } => format!("thread:{thread_id}"),
    })
}

fn query_records(
    connection: &Mutex<Connection>,
    query: Option<&str>,
    scope: Option<&MemoryScope>,
) -> anyhow::Result<Vec<MemoryRecord>> {
    let connection = connection.lock().unwrap();
    let scope_key_value = scope.map(scope_key).transpose()?;
    let pattern = query.map(|value| format!("%{}%", value.to_lowercase()));
    let sql = match (pattern.is_some(), scope_key_value.is_some()) {
        (false, false) => "SELECT key, value_json, class, scope_json, source, approved, created_at, updated_at FROM memory_records ORDER BY updated_at DESC",
        (false, true) => "SELECT key, value_json, class, scope_json, source, approved, created_at, updated_at FROM memory_records WHERE scope_key = ?1 ORDER BY updated_at DESC",
        (true, false) => "SELECT key, value_json, class, scope_json, source, approved, created_at, updated_at FROM memory_records WHERE lower(key) LIKE ?1 OR lower(value_json) LIKE ?1 ORDER BY updated_at DESC",
        (true, true) => "SELECT key, value_json, class, scope_json, source, approved, created_at, updated_at FROM memory_records WHERE scope_key = ?1 AND (lower(key) LIKE ?2 OR lower(value_json) LIKE ?2) ORDER BY updated_at DESC",
    };
    let mut statement = connection.prepare(sql)?;
    let rows = match (scope_key_value, pattern) {
        (None, None) => statement.query_map([], row_to_record)?,
        (Some(scope), None) => statement.query_map([scope], row_to_record)?,
        (None, Some(pattern)) => statement.query_map([pattern], row_to_record)?,
        (Some(scope), Some(pattern)) => {
            statement.query_map(params![scope, pattern], row_to_record)?
        }
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let value_json: String = row.get(1)?;
    let class: String = row.get(2)?;
    let scope_json: String = row.get(3)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    let convert = |index: usize, error: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error)
    };
    Ok(MemoryRecord {
        key: row.get(0)?,
        value: serde_json::from_str(&value_json).map_err(|error| convert(1, Box::new(error)))?,
        class: match class.as_str() {
            "operational" => MemoryClass::Operational,
            "personal" => MemoryClass::Personal,
            other => {
                return Err(convert(
                    2,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("unknown memory class {other}"),
                    )),
                ))
            }
        },
        scope: serde_json::from_str(&scope_json).map_err(|error| convert(3, Box::new(error)))?,
        source: row.get(4)?,
        approved: row.get::<_, i64>(5)? != 0,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| convert(6, Box::new(error)))?,
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| convert(7, Box::new(error)))?,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn operational_memory_persists_across_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("memory.sqlite");
        {
            let store = SqliteMemoryStore::open(&path).unwrap();
            store
                .put(MemoryRecord::operational(
                    "last_repo",
                    json!("zero3-pilot"),
                    MemoryScope::Global,
                    "runtime",
                ))
                .unwrap();
        }
        let reopened = SqliteMemoryStore::open(&path).unwrap();
        assert_eq!(
            reopened
                .get("last_repo", &MemoryScope::Global)
                .unwrap()
                .unwrap()
                .value,
            json!("zero3-pilot")
        );
    }

    #[test]
    fn personal_memory_without_explicit_approval_is_rejected() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let err = store
            .put(MemoryRecord::personal(
                "preference",
                json!("dark"),
                MemoryScope::Global,
                "agent",
                false,
            ))
            .unwrap_err();
        assert!(err.to_string().contains("requires explicit approval"));
        assert!(store
            .get("preference", &MemoryScope::Global)
            .unwrap()
            .is_none());
    }

    #[test]
    fn scopes_do_not_leak_into_each_other_and_search_is_scoped() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        store
            .put(MemoryRecord::operational(
                "topic",
                json!("browser automation"),
                MemoryScope::Session {
                    session_id: "s1".into(),
                },
                "test",
            ))
            .unwrap();
        store
            .put(MemoryRecord::operational(
                "topic",
                json!("scheduler"),
                MemoryScope::Session {
                    session_id: "s2".into(),
                },
                "test",
            ))
            .unwrap();
        let scope = MemoryScope::Session {
            session_id: "s1".into(),
        };
        let found = store.search("browser", Some(&scope)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].value, json!("browser automation"));
    }
}
