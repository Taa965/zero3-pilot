\set ON_ERROR_STOP on

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '55555555-5555-4555-8555-555555555555', 'project-b', 'codex-2', 'codex',
  'decision.recorded', 'project', 60, 'decision', 'decision-1', 0,
  '{"text":"Project B independent decision"}'::jsonb, 'task', now()
);

DO $$
DECLARE
  v_count BIGINT;
  v_a TEXT;
  v_b TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM memory_entities WHERE entity_id = 'decision-1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected same entity_id in two independent scopes, got % rows', v_count;
  END IF;

  SELECT content->>'text' INTO v_a FROM memory_entities
   WHERE scope_key = 'project:project-a' AND entity_id = 'decision-1';
  SELECT content->>'text' INTO v_b FROM memory_entities
   WHERE scope_key = 'project:project-b' AND entity_id = 'decision-1';

  IF v_a <> 'User-approved final decision' THEN
    RAISE EXCEPTION 'project A entity changed unexpectedly: %', v_a;
  END IF;
  IF v_b <> 'Project B independent decision' THEN
    RAISE EXCEPTION 'project B entity missing: %', v_b;
  END IF;

  IF (SELECT decisions->0->>'text' FROM project_memory_projection WHERE project_id = 'project-b') <> 'Project B independent decision' THEN
    RAISE EXCEPTION 'project B projection is not isolated';
  END IF;
END $$;
