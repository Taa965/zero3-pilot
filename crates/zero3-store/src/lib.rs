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
//!   original order and is fatal on *any* corrupt line, including the
//!   last one — use it when you need a hard guarantee the log is intact.
//!   `replay_recoverable()` additionally tolerates a corrupt/incomplete
//!   **last** line (the shape a crash mid-`write` leaves behind) without
//!   losing every event before it — see `RecoveredReplay`. Either way, a
//!   corrupt line anywhere *but* the last one is always fatal; nothing is
//!   silently skipped.

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

/// The result of a crash-tolerant replay: every event that parsed cleanly,
/// plus (if the very last line in the file was corrupt or incomplete)
/// metadata about that tail instead of a hard failure. A corrupt line
/// anywhere else in the file still fails the whole replay — this only
/// tolerates the specific shape a crash mid-`write_all` leaves behind.
#[derive(Debug)]
pub struct RecoveredReplay {
    pub events: Vec<Event>,
    pub truncated_tail: Option<TruncatedTail>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedTail {
    pub line: usize,
    pub raw: String,
    pub reason: String,
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

    /// Every line, 1-indexed by its real position in the file (blank lines
    /// skipped but not counted as gaps in numbering — the number always
    /// matches what a human would see opening the file in an editor).
    fn read_lines(&self) -> Result<Vec<(usize, String)>, StoreError> {
        let file = File::open(&self.path).map_err(|source| StoreError::Open {
            path: self.path.clone(),
            source,
        })?;
        let reader = BufReader::new(file);
        let mut lines = Vec::new();
        for (idx, line) in reader.lines().enumerate() {
            let line = line.map_err(|source| StoreError::Open {
                path: self.path.clone(),
                source,
            })?;
            if line.trim().is_empty() {
                continue;
            }
            lines.push((idx + 1, line));
        }
        Ok(lines)
    }

    /// Full history, in the order it was appended (including everything
    /// written by earlier processes against this same file). Fatal on any
    /// corrupt line, including the last one — see the module docs for the
    /// tolerant alternative.
    pub fn replay(&self) -> Result<Vec<Event>, StoreError> {
        self.read_lines()?
            .into_iter()
            .map(|(line_no, raw)| {
                serde_json::from_str(&raw).map_err(|source| StoreError::Corrupt {
                    path: self.path.clone(),
                    line: line_no,
                    source,
                })
            })
            .collect()
    }

    /// Like [`replay`](Self::replay), but a corrupt/incomplete *last* line
    /// is reported as `truncated_tail` instead of failing the whole
    /// replay — the shape a process crash mid-`write_all` leaves behind.
    /// A corrupt line anywhere else is still a hard `Err`.
    pub fn replay_recoverable(&self) -> Result<RecoveredReplay, StoreError> {
        let lines = self.read_lines()?;
        let last_idx = lines.len().saturating_sub(1);
        let mut events = Vec::with_capacity(lines.len());
        let mut truncated_tail = None;

        for (i, (line_no, raw)) in lines.into_iter().enumerate() {
            match serde_json::from_str::<Event>(&raw) {
                Ok(event) => events.push(event),
                Err(e) if i == last_idx => {
                    truncated_tail = Some(TruncatedTail {
                        line: line_no,
                        raw,
                        reason: e.to_string(),
                    });
                }
                Err(source) => {
                    return Err(StoreError::Corrupt {
                        path: self.path.clone(),
                        line: line_no,
                        source,
                    });
                }
            }
        }

        Ok(RecoveredReplay {
            events,
            truncated_tail,
        })
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

    fn replay(&self) -> anyhow::Result<Vec<Event>> {
        EventStore::replay(self).map_err(Into::into)
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
                EventKind::JobCompleted {
                    job_id: job_1,
                    output: serde_json::json!(null),
                },
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

    /// P0-3: a crash mid-`write_all` leaves a torn final line. `replay`
    /// (strict) must still treat that as fatal corruption...
    #[test]
    fn strict_replay_treats_a_crash_tail_as_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "one".into(),
                },
                None,
            ))
            .unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "two".into(),
                },
                None,
            ))
            .unwrap();
        // Simulate a crash mid-write: an incomplete JSON object, no
        // trailing newline — bypasses EventStore::append on purpose.
        let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
        write!(raw, "{{\"id\":\"partial").unwrap();
        raw.sync_data().unwrap();

        let err = store.replay().unwrap_err();
        assert!(matches!(err, StoreError::Corrupt { line: 3, .. }));
    }

    /// ...but `replay_recoverable` must recover both valid events before
    /// it and report the tail explicitly, rather than losing everything
    /// or silently dropping the tail.
    #[test]
    fn recoverable_replay_salvages_events_before_a_crash_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "one".into(),
                },
                None,
            ))
            .unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "two".into(),
                },
                None,
            ))
            .unwrap();
        let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
        write!(raw, "{{\"id\":\"partial").unwrap();
        raw.sync_data().unwrap();

        let recovered = store.replay_recoverable().unwrap();
        assert_eq!(recovered.events.len(), 2);
        let tail = recovered.truncated_tail.expect("tail should be reported");
        assert_eq!(tail.line, 3);
        assert!(tail.raw.starts_with("{\"id\":\"partial"));
    }

    /// P0-3 hard requirement: corruption in the *middle* of the file must
    /// never be silently tolerated, even by the "recoverable" replay —
    /// only a torn *last* line gets special treatment.
    #[test]
    fn recoverable_replay_still_fails_hard_on_mid_file_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "one".into(),
                },
                None,
            ))
            .unwrap();
        store
            .append(&log_event(
                EventKind::Log {
                    level: LogLevel::Info,
                    message: "three".into(),
                },
                None,
            ))
            .unwrap();

        // Corrupt the *middle* line by rewriting the whole file with a
        // bad line 2 followed by a perfectly valid line 3.
        let good_first = std::fs::read_to_string(&path).unwrap();
        let first_line = good_first.lines().next().unwrap();
        let valid_third = serde_json::to_string(&log_event(
            EventKind::Log {
                level: LogLevel::Info,
                message: "three".into(),
            },
            None,
        ))
        .unwrap();
        std::fs::write(
            &path,
            format!("{first_line}\nnot valid json at all\n{valid_third}\n"),
        )
        .unwrap();

        let store = EventStore::open(&path).unwrap();
        let strict_err = store.replay().unwrap_err();
        assert!(matches!(strict_err, StoreError::Corrupt { line: 2, .. }));

        let recoverable_err = store.replay_recoverable().unwrap_err();
        assert!(matches!(
            recoverable_err,
            StoreError::Corrupt { line: 2, .. }
        ));
    }
}
