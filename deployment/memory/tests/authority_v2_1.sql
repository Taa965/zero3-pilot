\set ON_ERROR_STOP on

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_events (
      event_id, project_id, agent_id, agent_type, event_type, memory_class,
      authority, entity_type, entity_id, expected_entity_version, payload,
      source_type, created_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000100', 'project-a', 'codex-1', 'codex',
      'decision.recorded', 'project', 100, 'decision', 'decision-user-denied', 0,
      '{"text":"must fail"}'::jsonb, 'task', now()
    );
    RAISE EXCEPTION 'expected user_authority_boundary';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'user_authority_boundary' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, confidence, entity_type, entity_id, expected_entity_version,
  payload, source_type, created_at
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'project-a', 'codex-1', 'codex',
  'decision.recorded', 'project', 60, 0.9, 'decision', 'decision-1', 0,
  '{"text":"AWS is the shared memory authority"}'::jsonb, 'task', now()
);

DO $$
DECLARE
  v_version BIGINT;
  v_event_sequence BIGINT;
  v_decisions JSONB;
  v_entity_version BIGINT;
BEGIN
  SELECT sequence INTO v_event_sequence FROM memory_events
    WHERE event_id = '11111111-1111-4111-8111-111111111111';
  SELECT version, decisions INTO v_version, v_decisions
    FROM project_memory_projection WHERE project_id = 'project-a';
  IF v_version <> v_event_sequence THEN
    RAISE EXCEPTION 'projection version expected event sequence %, got %', v_event_sequence, v_version;
  END IF;
  IF jsonb_array_length(v_decisions) <> 1 THEN RAISE EXCEPTION 'expected one projected decision'; END IF;
  IF v_decisions->0->>'text' <> 'AWS is the shared memory authority' THEN RAISE EXCEPTION 'unexpected projected decision'; END IF;
  SELECT current_version INTO v_entity_version FROM memory_entities WHERE entity_id = 'decision-1';
  IF v_entity_version <> 1 THEN RAISE EXCEPTION 'entity version expected 1, got %', v_entity_version; END IF;
END $$;

-- Exact retry must reach the unique idempotency key rather than failing on the
-- now-newer entity version.
INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, confidence, entity_type, entity_id, expected_entity_version,
  payload, source_type, created_at
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'project-a', 'codex-1', 'codex',
  'decision.recorded', 'project', 60, 0.9, 'decision', 'decision-1', 0,
  '{"text":"AWS is the shared memory authority"}'::jsonb, 'task', now()
)
ON CONFLICT (event_id) DO NOTHING;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM memory_events WHERE event_id = '11111111-1111-4111-8111-111111111111') <> 1 THEN
    RAISE EXCEPTION 'event idempotency failed';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_events (
      event_id, project_id, agent_id, agent_type, event_type, memory_class,
      authority, entity_type, entity_id, expected_entity_version, payload,
      source_type, created_at
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', 'project-a', 'claude-1', 'claude',
      'decision.recorded', 'project', 60, 'decision', 'decision-1', 0,
      '{"text":"stale writer"}'::jsonb, 'task', now()
    );
    RAISE EXCEPTION 'expected entity_version_conflict';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'entity_version_conflict' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_events (
      event_id, project_id, agent_id, agent_type, event_type, memory_class,
      authority, entity_type, entity_id, expected_entity_version, payload,
      source_type, created_at
    ) VALUES (
      '33333333-3333-4333-8333-333333333333', 'project-a', 'claude-1', 'claude',
      'decision.recorded', 'project', 45, 'decision', 'decision-1', 1,
      '{"text":"lower authority"}'::jsonb, 'task', now()
    );
    RAISE EXCEPTION 'expected authority_conflict';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'authority_conflict' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '44444444-4444-4444-8444-444444444444', 'project-a', 'user-boundary', 'system',
  'decision.recorded', 'project', 100, 'decision', 'decision-1', 1,
  '{"text":"User-approved final decision"}'::jsonb, 'system', now()
);

DO $$
DECLARE
  v_content JSONB;
  v_authority SMALLINT;
  v_version BIGINT;
BEGIN
  SELECT content, authority, current_version INTO v_content, v_authority, v_version
    FROM memory_entities WHERE entity_id = 'decision-1';
  IF v_authority <> 100 OR v_version <> 2 OR v_content->>'text' <> 'User-approved final decision' THEN
    RAISE EXCEPTION 'user authority projection mismatch';
  END IF;
  IF (SELECT decisions->0->>'text' FROM project_memory_projection WHERE project_id = 'project-a') <> 'User-approved final decision' THEN
    RAISE EXCEPTION 'project projection did not replace the current decision entity';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE memory_events SET source_ref = 'illegal-mutation'
     WHERE event_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected append-only rejection';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'memory_events is append-only%' THEN RAISE; END IF;
  END;
END $$;
