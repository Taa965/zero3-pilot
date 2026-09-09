BEGIN;

-- Task IDs are globally scoped by the frozen V2.1 contract. Bind each task to
-- its original project so another project's grant cannot modify its projection.
CREATE OR REPLACE FUNCTION validate_memory_event_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE existing memory_events%ROWTYPE;
BEGIN
    SELECT * INTO existing FROM memory_events WHERE event_id = NEW.event_id;
    IF FOUND THEN
        IF (to_jsonb(existing) - 'sequence' - 'ingested_at') IS DISTINCT FROM
           (to_jsonb(NEW) - 'sequence' - 'ingested_at') THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='event_id_payload_conflict';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.task_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM memory_events WHERE task_id=NEW.task_id
        AND project_id IS DISTINCT FROM NEW.project_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='task_project_mismatch';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS memory_event_identity_guard ON memory_events;
CREATE TRIGGER memory_event_identity_guard BEFORE INSERT ON memory_events
    FOR EACH ROW EXECUTE FUNCTION validate_memory_event_identity();
COMMIT;
