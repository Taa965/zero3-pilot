BEGIN;

CREATE OR REPLACE FUNCTION validate_memory_event_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_authority SMALLINT;
    current_version BIGINT;
BEGIN
    -- Retries of an already committed event must reach ON CONFLICT DO NOTHING
    -- without being rejected by a newer entity version. The unique event_id
    -- remains the idempotency key; the authoritative row is never mutated.
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

    SELECT authority, current_version
      INTO current_authority, current_version
      FROM memory_entities
     WHERE entity_id = NEW.entity_id
     FOR UPDATE;

    IF NEW.expected_entity_version IS NOT NULL
       AND NEW.expected_entity_version <> COALESCE(current_version, 0) THEN
        RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'entity_version_conflict',
            DETAIL = format('entity=%s expected=%s current=%s', NEW.entity_id, NEW.expected_entity_version, COALESCE(current_version, 0));
    END IF;

    IF current_authority IS NOT NULL AND NEW.authority < current_authority THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'authority_conflict',
            DETAIL = format('entity=%s incoming=%s current=%s', NEW.entity_id, NEW.authority, current_authority);
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
