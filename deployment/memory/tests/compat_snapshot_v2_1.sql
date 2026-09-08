\set ON_ERROR_STOP on

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, confidence, entity_type, entity_id, payload, source_type, created_at
) VALUES (
  '91000000-0000-4000-8000-000000000001', 'project-compat',
  'codex-compat', 'codex', 'project.context.replaced', 'project',
  60, 1.0, 'project_context', 'project-context',
  '{"expectedVersion":0,"context":{"decisions":[{"text":"base"}],"currentFocus":null,"pitfalls":[],"glossary":{"Authority":"AWS"},"constraints":[],"policies":[]}}'::jsonb,
  'task', now()
);

DO $$
DECLARE p project_memory_projection%ROWTYPE;
BEGIN
  SELECT * INTO p FROM project_memory_projection WHERE project_id='project-compat';
  IF p.version <= 0 THEN RAISE EXCEPTION 'compat projection version did not advance'; END IF;
  IF p.decisions->0->>'text' <> 'base' THEN RAISE EXCEPTION 'compat base decision missing'; END IF;
  IF p.glossary->>'Authority' <> 'AWS' THEN RAISE EXCEPTION 'compat base glossary missing'; END IF;
END $$;
DO $$
BEGIN
  BEGIN
    INSERT INTO memory_events (
      event_id, project_id, agent_id, agent_type, event_type, memory_class,
      authority, entity_type, entity_id, payload, source_type, created_at
    ) VALUES (
      '91000000-0000-4000-8000-000000000002', 'project-compat',
      'claude-compat', 'claude', 'project.context.replaced', 'project',
      60, 'project_context', 'project-context-stale',
      '{"expectedVersion":0,"context":{"decisions":[]}}'::jsonb,
      'task', now()
    );
    RAISE EXCEPTION 'expected project_context_version_conflict';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'project_context_version_conflict' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '91000000-0000-4000-8000-000000000003', 'project-compat',
  'codex-compat', 'codex', 'decision.recorded', 'project',
  60, 'decision', 'decision-after-snapshot', 0,
  '{"text":"typed-after"}'::jsonb, 'task', now()
);
DO $$
DECLARE p project_memory_projection%ROWTYPE;
BEGIN
  SELECT * INTO p FROM project_memory_projection WHERE project_id='project-compat';
  IF jsonb_array_length(p.decisions) <> 2 THEN
    RAISE EXCEPTION 'typed event was not layered after compat snapshot: %', p.decisions;
  END IF;
  IF p.decisions->1->>'text' <> 'typed-after' THEN
    RAISE EXCEPTION 'typed event ordering mismatch';
  END IF;
  IF p.last_sequence <> (SELECT max(sequence) FROM memory_events WHERE project_id='project-compat') THEN
    RAISE EXCEPTION 'compat last_sequence mismatch';
  END IF;
END $$;

DELETE FROM project_memory_projection WHERE project_id='project-compat';
SELECT rebuild_project_memory_projection('project-compat');

DO $$
BEGIN
  IF (SELECT jsonb_array_length(decisions) FROM project_memory_projection WHERE project_id='project-compat') <> 2 THEN
    RAISE EXCEPTION 'compat projection is not replayable';
  END IF;
END $$;
