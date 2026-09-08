BEGIN;

CREATE OR REPLACE FUNCTION rebuild_task_memory_projection(p_task_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_project_id TEXT;
    v_last_sequence BIGINT;
    v_status TEXT;
    v_requirements JSONB;
    v_ownership JSONB;
    v_progress JSONB;
    v_blockers JSONB;
    v_verified_results JSONB;
    v_handoffs JSONB;
    v_artifacts JSONB;
BEGIN
    IF p_task_id IS NULL OR btrim(p_task_id) = '' THEN
        RETURN;
    END IF;

    SELECT project_id, sequence
      INTO v_project_id, v_last_sequence
      FROM memory_events
     WHERE task_id = p_task_id
     ORDER BY sequence DESC
     LIMIT 1;

    IF v_last_sequence IS NULL THEN
        DELETE FROM task_memory_projection WHERE task_id = p_task_id;
        RETURN;
    END IF;

    SELECT CASE event_type
        WHEN 'task.completed' THEN 'completed'
        WHEN 'task.failed' THEN 'failed'
        WHEN 'task.blocked' THEN 'blocked'
        WHEN 'task.verified' THEN 'verified'
        WHEN 'task.assigned' THEN 'assigned'
        WHEN 'task.created' THEN 'created'
        ELSE 'running'
    END
      INTO v_status
      FROM memory_events
     WHERE task_id = p_task_id
       AND event_type IN (
         'task.created', 'task.assigned', 'task.progress', 'task.blocked',
         'task.unblocked', 'task.verified', 'task.completed', 'task.failed'
       )
     ORDER BY sequence DESC
     LIMIT 1;

    v_status := COALESCE(v_status, 'running');

    SELECT COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type IN ('task.created', 'task.requirement.updated')), '[]'::jsonb),
           COALESCE((array_agg(payload ORDER BY sequence DESC)
             FILTER (WHERE event_type = 'task.assigned'))[1], '{}'::jsonb),
           COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type = 'task.progress'), '[]'::jsonb),
           COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type IN ('task.blocked', 'task.unblocked')), '[]'::jsonb),
           COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type = 'task.verified'), '[]'::jsonb),
           COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type = 'handoff.published'), '[]'::jsonb),
           COALESCE(jsonb_agg(payload ORDER BY sequence)
             FILTER (WHERE event_type = 'artifact.recorded'), '[]'::jsonb)
      INTO v_requirements, v_ownership, v_progress, v_blockers,
           v_verified_results, v_handoffs, v_artifacts
      FROM memory_events
     WHERE task_id = p_task_id;

    INSERT INTO task_memory_projection (
        task_id, project_id, status, requirements, ownership, progress,
        blockers, verified_results, handoffs, artifacts, last_sequence, updated_at
    ) VALUES (
        p_task_id, COALESCE(v_project_id, ''), v_status, v_requirements,
        v_ownership, v_progress, v_blockers, v_verified_results, v_handoffs,
        v_artifacts, v_last_sequence, now()
    )
    ON CONFLICT (task_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        status = EXCLUDED.status,
        requirements = EXCLUDED.requirements,
        ownership = EXCLUDED.ownership,
        progress = EXCLUDED.progress,
        blockers = EXCLUDED.blockers,
        verified_results = EXCLUDED.verified_results,
        handoffs = EXCLUDED.handoffs,
        artifacts = EXCLUDED.artifacts,
        last_sequence = EXCLUDED.last_sequence,
        updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION apply_memory_event_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    next_version BIGINT;
    v_scope_key TEXT;
BEGIN
    IF NEW.entity_id IS NOT NULL AND NEW.entity_type IS NOT NULL THEN
        v_scope_key := memory_scope_key(NEW.memory_class, NEW.project_id, NEW.task_id);

        SELECT COALESCE(current_version, 0) + 1
          INTO next_version
          FROM memory_entities
         WHERE scope_key = v_scope_key
           AND entity_id = NEW.entity_id;
        next_version := COALESCE(next_version, 1);

        IF array_length(NEW.supersedes, 1) IS NOT NULL THEN
            UPDATE memory_entities
               SET verification_status = 'superseded', updated_at = NEW.created_at
             WHERE source_event_id = ANY(NEW.supersedes);
        END IF;

        INSERT INTO memory_entities (
            scope_key, entity_id, entity_type, project_id, task_id, memory_class,
            authority, confidence, verification_status, title, content,
            source_event_id, current_version, created_at, updated_at
        ) VALUES (
            v_scope_key, NEW.entity_id, NEW.entity_type, NEW.project_id, NEW.task_id,
            NEW.memory_class, NEW.authority, NEW.confidence,
            memory_verification_status(NEW.event_type),
            NULLIF(NEW.payload->>'title', ''), NEW.payload, NEW.event_id,
            next_version, NEW.created_at, NEW.created_at
        )
        ON CONFLICT (scope_key, entity_id) DO UPDATE SET
            entity_type = EXCLUDED.entity_type,
            project_id = EXCLUDED.project_id,
            task_id = EXCLUDED.task_id,
            memory_class = EXCLUDED.memory_class,
            authority = EXCLUDED.authority,
            confidence = EXCLUDED.confidence,
            verification_status = EXCLUDED.verification_status,
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            source_event_id = EXCLUDED.source_event_id,
            current_version = EXCLUDED.current_version,
            updated_at = EXCLUDED.updated_at;
    END IF;

    PERFORM rebuild_project_memory_projection(NEW.project_id);
    PERFORM rebuild_task_memory_projection(NEW.task_id);
    RETURN NEW;
END;
$$;

COMMIT;
