BEGIN;

CREATE OR REPLACE FUNCTION validate_memory_event_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_current_authority SMALLINT;
    v_current_version BIGINT;
    v_scope_key TEXT;
    v_lock_key BIGINT;
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

    -- A row lock cannot serialize two writers while an entity does not exist
    -- yet. Use an xact-scoped advisory lock keyed by scope + entity so version
    -- zero has the same optimistic-concurrency semantics as later versions.
    v_lock_key := hashtextextended(v_scope_key || chr(31) || NEW.entity_id, 0);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT e.authority, e.current_version
      INTO v_current_authority, v_current_version
      FROM memory_entities AS e
     WHERE e.scope_key = v_scope_key
       AND e.entity_id = NEW.entity_id
     FOR UPDATE;

    IF NEW.expected_entity_version IS NOT NULL
       AND NEW.expected_entity_version <> COALESCE(v_current_version, 0) THEN
        RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'entity_version_conflict',
            DETAIL = format('scope=%s entity=%s expected=%s current=%s', v_scope_key, NEW.entity_id, NEW.expected_entity_version, COALESCE(v_current_version, 0));
    END IF;

    IF v_current_authority IS NOT NULL AND NEW.authority < v_current_authority THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'authority_conflict',
            DETAIL = format('scope=%s entity=%s incoming=%s current=%s', v_scope_key, NEW.entity_id, NEW.authority, v_current_authority);
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
