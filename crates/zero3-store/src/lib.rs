//! Event Store v1: an append-only JSONL file backing
//! [`zero3_core::event::EventLog`], with replay and session/job
//! correlation.
//!
//! - **Append-only**: `append` never seeks or truncates — it always writes
//!   to the end of the file and `fsync`s, so a crash mid-write can only
//!   ever lose the last unflushed record, never corrupt earlier ones.
//! - **Persistent**: state lives in a real file, not memory — a fresh
//!   `EventStore::open` on the same path sees everything written by a
//!   previous process.
//! - **Replay**: `replay()` reconstructs the full event history in
//!   original order; `replay_session`/`replay_job` filter by correlation
//!   id so a caller (e.g. a job manager rebuilding its in-memory index on
//!   startup) doesn't have to filter the whole log itself.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use uuid::Uuid;
use zero3_core::event::{Event, EventLog};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("failed to open event store at {path}: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to append event: {0}")]
    Append(#[source] std::io::Error),
    #[error("corrupt event store at {path} line {line}: {source}")]
    Corrupt {
        path: PathBuf,
        line: usize,
        #[source]
        source: serde_json::Error,
    },
}

pub struct EventStore {
    path: PathBuf,
    writer: Mutex<File>,
}

impl EventStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let writer = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|source| StoreError::Open {
                path: path.clone(),
                source,
            })?;
        Ok(Self {
            path,
            writer: Mutex::new(writer),
        })
    }

    pub fn append(&self, event: &Event) -> Result<(), StoreError> {
        let mut line = serde_json::to_string(event).map_err(|e| {
            StoreError::Append(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        })?;
        line.push('\n');

        let mut writer = self.writer.lock().unwrap();
        writer
            .write_all(line.as_bytes())
            .map_err(StoreError::Append)?;
        writer.sync_data().map_err(StoreError::Append)?;
        Ok(())
    }

    /// Full history, in the order it was appended (including everything
    /// written by earlier processes against this same file).
    pub fn replay(&self) -> Result<Vec<Event>, StoreError> {
        let file = File::open(&self.path).map_err(|source| StoreError::Open {
            path: self.path.clone(),
            source,
        })?;
        let reader = BufReader::new(file);
        let mut events = Vec::new();
        for (idx, line) in reader.lines().enumerate() {
            let line = line.map_err(|source| StoreError::Open {
                path: self.path.clone(),
                source,
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let event: Event =
                serde_json::from_str(&line).map_err(|source| StoreError::Corrupt {
                    path: self.path.clone(),
                    line: idx + 1,
                    source,
                })?;
            events.push(event);
        }
        Ok(events)
    }

    pub fn replay_session(&self, session_id: Uuid) -> Result<Vec<Event>, StoreError> {
        Ok(self
            .replay()?
            .into_iter()
            .filter(|e| e.session_id == Some(session_id))
            .collect())
    }

    pub fn replay_job(&self, job_id: Uuid) -> Result<Vec<Event>, StoreError> {
        Ok(self
            .replay()?
            .into_iter()
            .filter(|e| e.job_id() == Some(job_id))
            .collect())
    }
}

impl EventLog for EventStore {
    fn append(&self, event: Event) -> anyhow::Result<()> {
        EventStore::append(self, &event).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zero3_core::event::{EventKind, EventSource, LogLevel};

    fn log_event(kind: EventKind, session: Option<Uuid>) -> Event {
        let e = Event::new(EventSource::System, kind);
        match session {
            Some(s) => e.with_session(s),
            None => e,
        }
    }

    #[test]
    fn append_then_replay_preserves_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();

        for i in 0..5 {
            store
                .append(&log_event(
                    EventKind::Log {
                        level: LogLevel::Info,
                        message: format!("event-{i}"),
                    },
                    None,
                ))
                .unwrap();
        }

        let replayed = store.replay().unwrap();
        assert_eq!(replayed.len(), 5);
        for (i, event) in replayed.iter().enumerate() {
            match &event.kind {
                EventKind::Log { message, .. } => assert_eq!(message, &format!("event-{i}")),
                other => panic!("unexpected kind: {other:?}"),
            }
        }
    }

    #[test]
    fn replay_survives_reopening_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");

        {
            let store = EventStore::open(&path).unwrap();
            store
                .append(&log_event(
                    EventKind::Log {
                        level: LogLevel::Info,
                        message: "before restart".into(),
                    },
                    None,
                ))
                .unwrap();
        } // store (and its file handle) dropped here — simulates a process restart

        let reopened = EventStore::open(&path).unwrap();
        reopened
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "after restart".into(),
                },
                None,
            ))
            .unwrap();

        let events = reopened.replay().unwrap();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn replay_session_and_job_filter_independently() {
        let dir = tempfile::tempdir().unwrap();
        let store = EventStore::open(dir.path().join("events.jsonl")).unwrap();

        let session_a = Uuid::new_v4();
        let session_b = Uuid::new_v4();
        let job_1 = Uuid::new_v4();
        let job_2 = Uuid::new_v4();

        store
            .append(&log_event(
                EventKind::JobStarted { job_id: job_1 },
                Some(session_a),
            ))
            .unwrap();
        store
            .append(&log_event(
                EventKind::JobStarted { job_id: job_2 },
                Some(session_a),
            ))
            .unwrap();
        store
            .append(&log_event(
                EventKind::JobCompleted { job_id: job_1 },
                Some(session_b),
            ))
            .unwrap();

        assert_eq!(store.replay_session(session_a).unwrap().len(), 2);
        assert_eq!(store.replay_session(session_b).unwrap().len(), 1);
        assert_eq!(store.replay_job(job_1).unwrap().len(), 2);
        assert_eq!(store.replay_job(job_2).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_line_is_reported_not_panicked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(&path, "not json\n").unwrap();

        let store = EventStore::open(&path).unwrap();
        let err = store.replay().unwrap_err();
        assert!(matches!(err, StoreError::Corrupt { line: 1, .. }));
    }
}
