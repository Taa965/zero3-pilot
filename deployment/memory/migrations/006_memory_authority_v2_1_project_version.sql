BEGIN;

CREATE OR REPLACE FUNCTION rebuild_project_memory_projection(p_project_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_last_sequence BIGINT;
    v_projection_version BIGINT;
    v_decisions JSONB;
    v_current_focus JSONB;
    v_pitfalls JSONB;
    v_glossary JSONB;
    v_constraints JSONB;
    v_policies JSONB;
BEGIN
    IF p_project_id IS NULL OR btrim(p_project_id) = '' THEN
        RETURN;
    END IF;

    SELECT COALESCE(MAX(sequence), 0),
           COALESCE(MAX(sequence) FILTER (WHERE memory_class = 'project'), 0)
      INTO v_last_sequence, v_projection_version
      FROM memory_events
     WHERE project_id = p_project_id;

    SELECT
        COALESCE(jsonb_agg(content ORDER BY updated_at, entity_id)
            FILTER (WHERE entity_type = 'decision' AND verification_status NOT IN ('superseded', 'revoked', 'contradicted')), '[]'::jsonb),
        COALESCE(jsonb_agg(content ORDER BY updated_at, entity_id)
            FILTER (WHERE entity_type = 'pitfall' AND verification_status NOT IN ('superseded', 'revoked')), '[]'::jsonb),
        COALESCE(jsonb_agg(content ORDER BY updated_at, entity_id)
            FILTER (WHERE entity_type = 'constraint' AND verification_status NOT IN ('superseded', 'revoked')), '[]'::jsonb),
        COALESCE(jsonb_agg(content ORDER BY updated_at, entity_id)
            FILTER (WHERE entity_type = 'policy' AND verification_status NOT IN ('superseded', 'revoked')), '[]'::jsonb)
      INTO v_decisions, v_pitfalls, v_constraints, v_policies
      FROM memory_entities
     WHERE project_id = p_project_id
       AND memory_class = 'project';

    SELECT content
      INTO v_current_focus
      FROM memory_entities
     WHERE project_id = p_project_id
       AND memory_class = 'project'
       AND entity_type = 'focus'
       AND verification_status NOT IN ('superseded', 'revoked')
     ORDER BY updated_at DESC, entity_id DESC
     LIMIT 1;

    SELECT COALESCE(jsonb_object_agg(content->>'term', content->'value'), '{}'::jsonb)
      INTO v_glossary
      FROM memory_entities
     WHERE project_id = p_project_id
       AND memory_class = 'project'
       AND entity_type = 'glossary'
       AND verification_status NOT IN ('superseded', 'revoked')
       AND content ? 'term'
       AND content ? 'value';

    INSERT INTO project_memory_projection (
        project_id, version, decisions, current_focus, pitfalls, glossary,
        constraints, policies, last_sequence, updated_at
    ) VALUES (
        p_project_id, v_projection_version, v_decisions, v_current_focus,
        v_pitfalls, v_glossary, v_constraints, v_policies, v_last_sequence, now()
    )
    ON CONFLICT (project_id) DO UPDATE SET
        version = EXCLUDED.version,
        decisions = EXCLUDED.decisions,
        current_focus = EXCLUDED.current_focus,
        pitfalls = EXCLUDED.pitfalls,
        glossary = EXCLUDED.glossary,
        constraints = EXCLUDED.constraints,
        policies = EXCLUDED.policies,
        last_sequence = EXCLUDED.last_sequence,
        updated_at = EXCLUDED.updated_at;
END;
$$;

COMMIT;
