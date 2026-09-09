BEGIN;

-- A cursor over BIGSERIAL is safe only if later sequences cannot commit first.
-- Acquire the transaction lock BEFORE allocating the default sequence value.
-- A BEFORE INSERT trigger is too late: defaults have already been evaluated.
CREATE OR REPLACE FUNCTION next_memory_event_sequence()
RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(730321, 1);
    RETURN nextval('memory_events_sequence_seq');
END;
$$;

ALTER TABLE memory_events ALTER COLUMN sequence SET DEFAULT next_memory_event_sequence();

COMMIT;
