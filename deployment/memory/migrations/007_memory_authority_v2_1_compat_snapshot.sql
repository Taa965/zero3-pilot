BEGIN;

CREATE OR REPLACE FUNCTION validate_memory_event_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_authority SMALLINT;
    v_current_entity_version BIGINT;
    v_scope_key TEXT;
    v_lock_key BIGINT;
    v_expected_project_version BIGINT;
    v_current_project_version BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM memory_events WHERE event_id = NEW.event_id) THEN
        RETURN NEW;
    END IF;

    IF NEW.authority = 100 AND NEW.agent_type <> 'system' THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'user_authority_boundary';
    END IF;

    IF NEW.event_type = 'project.context.replaced' THEN
        IF NEW.memory_class <> 'project' OR NEW.project_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project_context_scope_required';
        END IF;
        IF NOT (NEW.payload ? 'expectedVersion') OR jsonb_typeof(NEW.payload->'expectedVersion') <> 'number' THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project_context_expected_version_required';
        END IF;
        v_expected_project_version := (NEW.payload->>'expectedVersion')::BIGINT;
        PERFORM pg_advisory_xact_lock(hashtextextended('project-context' || chr(31) || NEW.project_id, 0));
        SELECT COALESCE(version, 0)
          INTO v_current_project_version
          FROM project_memory_projection
         WHERE project_id = NEW.project_id
         FOR UPDATE;
        v_current_project_version := COALESCE(v_current_project_version, 0);
        IF v_expected_project_version <> v_current_project_version THEN
            RAISE EXCEPTION USING
                ERRCODE = '40001',
                MESSAGE = 'project_context_version_conflict',
                DETAIL = format('project=%s expected=%s current=%s', NEW.project_id, v_expected_project_version, v_current_project_version);
        END IF;
    END IF;

    IF NEW.entity_id IS NULL OR NEW.entity_type IS NULL THEN
        RETURN NEW;
    END IF;

    v_scope_key := memory_scope_key(NEW.memory_class, NEW.project_id, NEW.task_id);
    v_lock_key := hashtextextended(v_scope_key || chr(31) || NEW.entity_id, 0);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT me.authority, me.current_version
      INTO current_authority, v_current_entity_version
      FROM memory_entities AS me
     WHERE me.scope_key = v_scope_key
       AND me.entity_id = NEW.entity_id
     FOR UPDATE;
    IF NEW.expected_entity_version IS NOT NULL
       AND NEW.expected_entity_version <> COALESCE(v_current_entity_version, 0) THEN
        RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'entity_version_conflict',
            DETAIL = format('scope=%s entity=%s expected=%s current=%s', v_scope_key, NEW.entity_id, NEW.expected_entity_version, COALESCE(v_current_entity_version, 0));
    END IF;

    IF current_authority IS NOT NULL AND NEW.authority < current_authority THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'authority_conflict',
            DETAIL = format('scope=%s entity=%s incoming=%s current=%s', v_scope_key, NEW.entity_id, NEW.authority, current_authority);
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rebuild_project_memory_projection(p_project_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_last_sequence BIGINT;
    v_projection_version BIGINT;
    v_base_sequence BIGINT := 0;
    v_base JSONB := '{}'::jsonb;
    v_decisions JSONB;
    v_current_focus JSONB;
    v_pitfalls JSONB;
    v_glossary JSONB;
    v_constraints JSONB;
    v_policies JSONB;
    v_later_focus JSONB;
    v_later_glossary JSONB;
BEGIN
    IF p_project_id IS NULL OR btrim(p_project_id) = '' THEN RETURN; END IF;

    SELECT COALESCE(MAX(sequence), 0),
           COALESCE(MAX(sequence) FILTER (WHERE memory_class = 'project'), 0)
      INTO v_last_sequence, v_projection_version
      FROM memory_events
     WHERE project_id = p_project_id;

    SELECT sequence, COALESCE(payload->'context', '{}'::jsonb)
      INTO v_base_sequence, v_base
      FROM memory_events
     WHERE project_id = p_project_id
       AND memory_class = 'project'
       AND event_type = 'project.context.replaced'
     ORDER BY sequence DESC
     LIMIT 1;
    v_base_sequence := COALESCE(v_base_sequence, 0);
    v_base := COALESCE(v_base, '{}'::jsonb);

    v_decisions := COALESCE(v_base->'decisions', '[]'::jsonb);
    v_current_focus := COALESCE(v_base->'currentFocus', 'null'::jsonb);
    v_pitfalls := COALESCE(v_base->'pitfalls', '[]'::jsonb);
    v_glossary := COALESCE(v_base->'glossary', '{}'::jsonb);
    v_constraints := COALESCE(v_base->'constraints', '[]'::jsonb);
    v_policies := COALESCE(v_base->'policies', '[]'::jsonb);

    SELECT
      COALESCE(jsonb_agg(me.content ORDER BY e.sequence, me.entity_id)
        FILTER (WHERE me.entity_type='decision' AND me.verification_status NOT IN ('superseded','revoked','contradicted')), '[]'::jsonb),
      COALESCE(jsonb_agg(me.content ORDER BY e.sequence, me.entity_id)
        FILTER (WHERE me.entity_type='pitfall' AND me.verification_status NOT IN ('superseded','revoked')), '[]'::jsonb),
      COALESCE(jsonb_agg(me.content ORDER BY e.sequence, me.entity_id)
        FILTER (WHERE me.entity_type='constraint' AND me.verification_status NOT IN ('superseded','revoked')), '[]'::jsonb),
      COALESCE(jsonb_agg(me.content ORDER BY e.sequence, me.entity_id)
        FILTER (WHERE me.entity_type='policy' AND me.verification_status NOT IN ('superseded','revoked')), '[]'::jsonb)
      INTO v_decisions, v_pitfalls, v_constraints, v_policies
      FROM memory_entities me
      JOIN memory_events e ON e.event_id = me.source_event_id
     WHERE me.project_id = p_project_id
       AND me.memory_class = 'project'
       AND e.sequence > v_base_sequence;

    v_decisions := COALESCE(v_base->'decisions', '[]'::jsonb) || v_decisions;
    v_pitfalls := COALESCE(v_base->'pitfalls', '[]'::jsonb) || v_pitfalls;
    v_constraints := COALESCE(v_base->'constraints', '[]'::jsonb) || v_constraints;
    v_policies := COALESCE(v_base->'policies', '[]'::jsonb) || v_policies;
    SELECT me.content
      INTO v_later_focus
      FROM memory_entities me
      JOIN memory_events e ON e.event_id = me.source_event_id
     WHERE me.project_id = p_project_id
       AND me.memory_class = 'project'
       AND me.entity_type = 'focus'
       AND me.verification_status NOT IN ('superseded','revoked')
       AND e.sequence > v_base_sequence
     ORDER BY e.sequence DESC, me.entity_id DESC
     LIMIT 1;
    IF v_later_focus IS NOT NULL THEN v_current_focus := v_later_focus; END IF;

    SELECT COALESCE(jsonb_object_agg(me.content->>'term', me.content->'value'), '{}'::jsonb)
      INTO v_later_glossary
      FROM memory_entities me
      JOIN memory_events e ON e.event_id = me.source_event_id
     WHERE me.project_id = p_project_id
       AND me.memory_class = 'project'
       AND me.entity_type = 'glossary'
       AND me.verification_status NOT IN ('superseded','revoked')
       AND me.content ? 'term' AND me.content ? 'value'
       AND e.sequence > v_base_sequence;
    v_glossary := v_glossary || COALESCE(v_later_glossary, '{}'::jsonb);
    INSERT INTO project_memory_projection (
      project_id, version, decisions, current_focus, pitfalls, glossary,
      constraints, policies, last_sequence, updated_at
    ) VALUES (
      p_project_id, v_projection_version, v_decisions, v_current_focus,
      v_pitfalls, v_glossary, v_constraints, v_policies, v_last_sequence, now()
    )
    ON CONFLICT (project_id) DO UPDATE SET
      version=EXCLUDED.version,
      decisions=EXCLUDED.decisions,
      current_focus=EXCLUDED.current_focus,
      pitfalls=EXCLUDED.pitfalls,
      glossary=EXCLUDED.glossary,
      constraints=EXCLUDED.constraints,
      policies=EXCLUDED.policies,
      last_sequence=EXCLUDED.last_sequence,
      updated_at=EXCLUDED.updated_at;
END;
$$;

COMMIT;
