\set ON_ERROR_STOP on

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '99999999-9999-4999-8999-999999999991', 'project-version', 'codex-v', 'codex',
  'decision.recorded', 'project', 60, 'decision', 'project-decision', 0,
  '{"text":"project authoritative decision"}'::jsonb, 'task', now()
);

DO $$
DECLARE
  v_version BIGINT;
  v_last BIGINT;
BEGIN
  SELECT version, last_sequence INTO v_version, v_last
    FROM project_memory_projection WHERE project_id='project-version';
  IF v_version <> v_last THEN
    RAISE EXCEPTION 'initial project event should set version and last_sequence equally';
  END IF;
END $$;

INSERT INTO memory_events (
  event_id, project_id, task_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '99999999-9999-4999-8999-999999999992', 'project-version', 'task-version', 'claude-v', 'claude',
  'task.progress', 'task', 45, 'decision', 'task-local-decision-shaped-entity', 0,
  '{"text":"task progress must not enter project decisions"}'::jsonb, 'task', now()
);

DO $$
DECLARE
  v_project_event_seq BIGINT;
  v_task_event_seq BIGINT;
  v_version BIGINT;
  v_last BIGINT;
  v_decisions JSONB;
BEGIN
  SELECT sequence INTO v_project_event_seq FROM memory_events
    WHERE event_id='99999999-9999-4999-8999-999999999991';
  SELECT sequence INTO v_task_event_seq FROM memory_events
    WHERE event_id='99999999-9999-4999-8999-999999999992';
  SELECT version, last_sequence, decisions INTO v_version, v_last, v_decisions
    FROM project_memory_projection WHERE project_id='project-version';

  IF v_version <> v_project_event_seq THEN
    RAISE EXCEPTION 'task traffic changed project context version: expected %, got %', v_project_event_seq, v_version;
  END IF;
  IF v_last <> v_task_event_seq THEN
    RAISE EXCEPTION 'project sync freshness did not advance with task event';
  END IF;
  IF jsonb_array_length(v_decisions) <> 1 OR v_decisions->0->>'text' <> 'project authoritative decision' THEN
    RAISE EXCEPTION 'task-class decision-shaped entity leaked into project projection';
  END IF;
END $$;
