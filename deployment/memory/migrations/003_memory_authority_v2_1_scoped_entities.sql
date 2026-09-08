BEGIN;

CREATE OR REPLACE FUNCTION memory_scope_key(
    p_memory_class TEXT,
    p_project_id TEXT,
    p_task_id TEXT
)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    CASE p_memory_class
        WHEN 'global' THEN
            RETURN 'global';
        WHEN 'project' THEN
            IF p_project_id IS NULL OR btrim(p_project_id) = '' THEN
                RAISE EXCEPTION 'project memory requires project_id';
            END IF;
            RETURN 'project:' || p_project_id;
        WHEN 'task' THEN
            IF p_task_id IS NULL OR btrim(p_task_id) = '' THEN
                RAISE EXCEPTION 'task memory requires task_id';
            END IF;
            RETURN 'task:' || p_task_id;
        ELSE
            RETURN p_memory_class || ':' || COALESCE(p_project_id, '') || ':' || COALESCE(p_task_id, '');
    END CASE;
END;
$$;

ALTER TABLE memory_entities ADD COLUMN IF NOT EXISTS scope_key TEXT;
UPDATE memory_entities
   SET scope_key = memory_scope_key(memory_class, project_id, task_id)
 WHERE scope_key IS NULL;
ALTER TABLE memory_entities ALTER COLUMN scope_key SET NOT NULL;
ALTER TABLE memory_entities DROP CONSTRAINT IF EXISTS memory_entities_pkey;
ALTER TABLE memory_entities ADD PRIMARY KEY (scope_key, entity_id);

CREATE INDEX IF NOT EXISTS idx_memory_entities_scope
    ON memory_entities(scope_key, entity_type, verification_status);

CREATE OR REPLACE FUNCTION validate_memory_event_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_authority SMALLINT;
    current_version BIGINT;
    v_scope_key TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM memory_events WHERE event_id = NEW.event_id) THEN
        RETURN NEW;
    END IF;

    IF NEW.authority = 100 AND NEW.agent_type <> 'system' THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'user_authority_boundary';
    END IF;

    IF NEW.entity_id IS NULL OR NEW.entity_type IS NULL THEN
        RETURN NEW;
    END IF;

    v_scope_key := memory_scope_key(NEW.memory_class, NEW.project_id, NEW.task_id);

    SELECT authority, current_version
      INTO current_authority, current_version
      FROM memory_entities
     WHERE scope_key = v_scope_key
       AND entity_id = NEW.entity_id
     FOR UPDATE;

    IF NEW.expected_entity_version IS NOT NULL
       AND NEW.expected_entity_version <> COALESCE(current_version, 0) THEN
        RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'entity_version_conflict',
            DETAIL = format('scope=%s entity=%s expected=%s current=%s', v_scope_key, NEW.entity_id, NEW.expected_entity_version, COALESCE(current_version, 0));
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
    RETURN NEW;
END;
$$;

COMMIT;
