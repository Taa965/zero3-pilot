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
//!   `replay_recoverable()` additionally tolerates a **physically
//!   unterminated final record** — the exact shape a crash mid-`write`
//!   leaves behind — without losing every event before it. A last line
//!   that *is* newline-terminated but contains invalid JSON is real
//!   corruption, not a crash tail, and is still fatal in both modes: the
//!   distinguishing fact is whether the file's last byte is `\n`, not
//!   merely "is this the last non-empty line."

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use uuid::Uuid;
use zero3_core::event::{Event, EventLog, RecoverableReplay, TruncatedTail};

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

    /// Every non-empty line, 1-indexed by its real position in the file,
    /// plus whether the *physical file* ends with `\n`. That second fact
    /// is what actually distinguishes a crash-torn tail from a complete
    /// (but possibly corrupt) final record — `str::lines()` strips
    /// newlines from every line uniformly, so without checking the raw
    /// byte we can't tell "last line, terminated" from "last line, not."
    fn read_lines_with_termination(&self) -> Result<(Vec<(usize, String)>, bool), StoreError> {
        let raw = std::fs::read_to_string(&self.path).map_err(|source| StoreError::Open {
            path: self.path.clone(),
            source,
        })?;
        let ends_with_newline = raw.ends_with('\n');
        let lines = raw
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(idx, line)| (idx + 1, line.to_string()))
            .collect();
        Ok((lines, ends_with_newline))
    }

    /// Full history, in the order it was appended (including everything
    /// written by earlier processes against this same file). Fatal on any
    /// corrupt line, including the last one — see the module docs for the
    /// tolerant alternative.
    pub fn replay(&self) -> Result<Vec<Event>, StoreError> {
        let (lines, _ends_with_newline) = self.read_lines_with_termination()?;
        lines
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

    /// Like [`replay`](Self::replay), but a **physically unterminated**
    /// final record — the file's last byte isn't `\n`, meaning the writer
    /// was almost certainly interrupted mid-`write_all` — is reported as
    /// `truncated_tail` instead of failing the whole replay. A last line
    /// that *does* end with `\n` but fails to parse is real corruption,
    /// not a crash tail, and is still a hard `Err` here too — as is
    /// corruption anywhere before the last line, in either mode.
    pub fn replay_recoverable(&self) -> Result<RecoverableReplay, StoreError> {
        let (lines, ends_with_newline) = self.read_lines_with_termination()?;
        let last_idx = lines.len().saturating_sub(1);
        let mut events = Vec::with_capacity(lines.len());
        let mut truncated_tail = None;

        for (i, (line_no, raw)) in lines.into_iter().enumerate() {
            match serde_json::from_str::<Event>(&raw) {
                Ok(event) => events.push(event),
                Err(e) => {
                    let is_physically_torn_tail = i == last_idx && !ends_with_newline;
                    if is_physically_torn_tail {
                        truncated_tail = Some(TruncatedTail {
                            line: line_no,
                            raw,
                            reason: e.to_string(),
                        });
                    } else {
                        return Err(StoreError::Corrupt {
                            path: self.path.clone(),
                            line: line_no,
                            source: e,
                        });
                    }
                }
            }
        }

        Ok(RecoverableReplay {
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

    fn replay_recoverable(&self) -> anyhow::Result<RecoverableReplay> {
        EventStore::replay_recoverable(self).map_err(Into::into)
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

    fn log_line(message: &str) -> Event {
        log_event(
            EventKind::Log {
                level: LogLevel::Info,
                message: message.to_string(),
            },
            None,
        )
    }

    #[test]
    fn append_then_replay_preserves_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();

        for i in 0..5 {
            store.append(&log_line(&format!("event-{i}"))).unwrap();
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
            store.append(&log_line("before restart")).unwrap();
        } // store (and its file handle) dropped here — simulates a process restart

        let reopened = EventStore::open(&path).unwrap();
        reopened.append(&log_line("after restart")).unwrap();

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

    /// P0-3: a crash mid-`write_all` leaves a physically unterminated
    /// final line. `replay` (strict) must still treat that as fatal
    /// corruption...
    #[test]
    fn strict_replay_treats_a_crash_tail_as_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store.append(&log_line("one")).unwrap();
        store.append(&log_line("two")).unwrap();
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
    /// or silently dropping the tail. (invalid last line, no trailing
    /// newline -> recoverable)
    #[test]
    fn recoverable_replay_salvages_events_before_an_unterminated_crash_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store.append(&log_line("one")).unwrap();
        store.append(&log_line("two")).unwrap();
        let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
        write!(raw, "{{\"id\":\"partial").unwrap(); // no trailing \n
        raw.sync_data().unwrap();

        let recovered = store.replay_recoverable().unwrap();
        assert_eq!(recovered.events.len(), 2);
        let tail = recovered.truncated_tail.expect("tail should be reported");
        assert_eq!(tail.line, 3);
        assert!(tail.raw.starts_with("{\"id\":\"partial"));
    }

    /// The bug this hardening pass fixes: a last line that IS
    /// newline-terminated but contains invalid JSON is a *complete write
    /// of corrupt content*, not a crash tail — `replay_recoverable` must
    /// still fail hard on it, not misclassify it as salvageable.
    #[test]
    fn recoverable_replay_treats_a_terminated_invalid_last_line_as_fatal_not_a_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store.append(&log_line("one")).unwrap();
        // Append a fully-formed, newline-terminated, but invalid line —
        // this is not what append() would ever produce; simulates
        // corruption from something else touching the file.
        let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(raw, "this is not valid json").unwrap(); // WITH trailing \n
        raw.sync_data().unwrap();

        let err = store.replay_recoverable().unwrap_err();
        assert!(matches!(err, StoreError::Corrupt { line: 2, .. }));
    }

    /// P0-3 hard requirement: corruption in the *middle* of the file must
    /// never be silently tolerated, even by the "recoverable" replay —
    /// only a physically torn *last* line gets special treatment.
    #[test]
    fn recoverable_replay_still_fails_hard_on_mid_file_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store.append(&log_line("one")).unwrap();
        store.append(&log_line("three")).unwrap();

        // Corrupt the *middle* line by rewriting the whole file with a
        // bad line 2 followed by a perfectly valid, terminated line 3.
        let good_first = std::fs::read_to_string(&path).unwrap();
        let first_line = good_first.lines().next().unwrap();
        let valid_third = serde_json::to_string(&log_line("three")).unwrap();
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

    /// A valid final line that just happens to lack a trailing newline
    /// (e.g. `sync_data` landed but the process died before the *next*
    /// write, or the file was hand-edited) must parse normally — it is
    /// not corrupt and must not be flagged as a truncated tail.
    #[test]
    fn valid_final_line_without_trailing_newline_is_not_flagged_as_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let store = EventStore::open(&path).unwrap();
        store.append(&log_line("one")).unwrap();

        let valid_second = serde_json::to_string(&log_line("two")).unwrap();
        let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
        write!(raw, "{valid_second}").unwrap(); // valid JSON, no trailing \n
        raw.sync_data().unwrap();

        let recovered = store.replay_recoverable().unwrap();
        assert_eq!(recovered.events.len(), 2);
        assert!(recovered.truncated_tail.is_none());
    }
}
