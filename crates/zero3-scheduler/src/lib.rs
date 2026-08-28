//! Minimal in-memory scheduler. A future version adds cron-style recurring
//! jobs and durable persistence; the public shape (`enqueue` / `status`)
//! should not need to change for that.

use std::collections::HashMap;
use std::sync::Mutex;

use uuid::Uuid;
use zero3_core::job::{JobSpec, JobStatus};

pub struct Scheduler {
    jobs: Mutex<HashMap<Uuid, (JobSpec, JobStatus)>>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
        }
    }

    pub fn enqueue(&self, spec: JobSpec) -> Uuid {
        let id = spec.id;
        self.jobs
            .lock()
            .unwrap()
            .insert(id, (spec, JobStatus::Queued));
        id
    }

    pub fn status(&self, id: Uuid) -> Option<JobStatus> {
        self.jobs.lock().unwrap().get(&id).map(|(_, s)| *s)
    }

    pub fn set_status(&self, id: Uuid, status: JobStatus) {
        if let Some(entry) = self.jobs.lock().unwrap().get_mut(&id) {
            entry.1 = status;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enqueue_and_track_status() {
        let scheduler = Scheduler::new();
        let spec = JobSpec {
            id: Uuid::new_v4(),
            kind: "test.noop".into(),
            payload: json!({}),
        };
        let id = scheduler.enqueue(spec);
        assert_eq!(scheduler.status(id), Some(JobStatus::Queued));
        scheduler.set_status(id, JobStatus::Succeeded);
        assert_eq!(scheduler.status(id), Some(JobStatus::Succeeded));
    }
}
