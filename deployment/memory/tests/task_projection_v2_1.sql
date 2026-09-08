\set ON_ERROR_STOP on

INSERT INTO memory_events (
  event_id, project_id, task_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES
(
  '88888888-8888-4888-8888-888888888881', 'project-task', 'task-1', 'zero3', 'zero3',
  'task.created', 'task', 60, 'task_state', 'task-1-state', 0,
  '{"requirements":["ship memory authority"]}'::jsonb, 'task', now()
),
(
  '88888888-8888-4888-8888-888888888882', 'project-task', 'task-1', 'zero3', 'zero3',
  'task.assigned', 'task', 60, 'task_assignment', 'task-1-assignment', 0,
  '{"owner":"codex"}'::jsonb, 'task', now()
),
(
  '88888888-8888-4888-8888-888888888883', 'project-task', 'task-1', 'codex-1', 'codex',
  'task.progress', 'task', 45, 'task_progress', 'task-1-progress-1', 0,
  '{"text":"protocol complete"}'::jsonb, 'task', now()
),
(
  '88888888-8888-4888-8888-888888888884', 'project-task', 'task-1', 'codex-1', 'codex',
  'handoff.published', 'task', 60, 'handoff', 'task-1-handoff-1', 0,
  '{"completed_work":["protocol"],"remaining_work":["server"]}'::jsonb, 'task', now()
),
(
  '88888888-8888-4888-8888-888888888885', 'project-task', 'task-1', 'claude-1', 'claude',
  'task.verified', 'task', 85, 'verified_result', 'task-1-verify-1', 0,
  '{"result":"tests passed"}'::jsonb, 'task', now()
 );

-- A later lifecycle event is a separate append operation in the actual
-- Memory Event API. Keep it in a separate SQL statement so optimistic
-- entity version 1 observes the projection committed by task.created.
INSERT INTO memory_events (
  event_id, project_id, task_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '88888888-8888-4888-8888-888888888886', 'project-task', 'task-1', 'zero3', 'zero3',
  'task.completed', 'task', 60, 'task_state', 'task-1-state', 1,
  '{"summary":"done"}'::jsonb, 'task', now()
);

DO $$
DECLARE
  p task_memory_projection%ROWTYPE;
BEGIN
  SELECT * INTO p FROM task_memory_projection WHERE task_id='task-1';
  IF p.project_id <> 'project-task' THEN RAISE EXCEPTION 'wrong task project'; END IF;
  IF p.status <> 'completed' THEN RAISE EXCEPTION 'wrong task status: %', p.status; END IF;
  IF jsonb_array_length(p.requirements) <> 1 THEN RAISE EXCEPTION 'task requirements projection mismatch'; END IF;
  IF p.ownership->>'owner' <> 'codex' THEN RAISE EXCEPTION 'task ownership projection mismatch'; END IF;
  IF jsonb_array_length(p.progress) <> 1 THEN RAISE EXCEPTION 'task progress projection mismatch'; END IF;
  IF jsonb_array_length(p.handoffs) <> 1 THEN RAISE EXCEPTION 'task handoff projection mismatch'; END IF;
  IF jsonb_array_length(p.verified_results) <> 1 THEN RAISE EXCEPTION 'task verification projection mismatch'; END IF;
  IF p.last_sequence <> (SELECT max(sequence) FROM memory_events WHERE task_id='task-1') THEN
    RAISE EXCEPTION 'task last_sequence mismatch';
  END IF;
END $$;

-- Prove the projection is a read model and can be rebuilt from event history.
DELETE FROM task_memory_projection WHERE task_id='task-1';
SELECT rebuild_task_memory_projection('task-1');

DO $$
BEGIN
  IF (SELECT status FROM task_memory_projection WHERE task_id='task-1') <> 'completed' THEN
    RAISE EXCEPTION 'task projection rebuild failed';
  END IF;
  IF (SELECT jsonb_array_length(handoffs) FROM task_memory_projection WHERE task_id='task-1') <> 1 THEN
    RAISE EXCEPTION 'task handoff rebuild failed';
  END IF;
END $$;
