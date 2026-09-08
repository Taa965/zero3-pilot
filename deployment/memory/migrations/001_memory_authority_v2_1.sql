BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_events (
    sequence BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    project_id TEXT,
    task_id TEXT,
    session_id TEXT,
    thread_id TEXT,
    agent_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    device_id TEXT,
    event_type TEXT NOT NULL,
    memory_class TEXT NOT NULL,
    authority SMALLINT NOT NULL CHECK (authority BETWEEN 0 AND 100),
    confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    entity_type TEXT,
    entity_id TEXT,
    expected_entity_version BIGINT CHECK (expected_entity_version IS NULL OR expected_entity_version >= 0),
    parent_event_id UUID,
    supersedes UUID[] NOT NULL DEFAULT '{}',
    payload JSONB NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    source_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_events_project_sequence
    ON memory_events(project_id, sequence);
CREATE INDEX IF NOT EXISTS idx_memory_events_task_sequence
    ON memory_events(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_memory_events_entity
    ON memory_events(entity_type, entity_id, sequence);

CREATE TABLE IF NOT EXISTS memory_entities (
    entity_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    project_id TEXT,
    task_id TEXT,
    memory_class TEXT NOT NULL,
    authority SMALLINT NOT NULL CHECK (authority BETWEEN 0 AND 100),
    confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    verification_status TEXT NOT NULL,
    title TEXT,
    content JSONB NOT NULL,
    source_event_id UUID NOT NULL REFERENCES memory_events(event_id),
    current_version BIGINT NOT NULL CHECK (current_version >= 1),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_project
    ON memory_entities(project_id, memory_class, verification_status);

CREATE TABLE IF NOT EXISTS project_memory_projection (
    project_id TEXT PRIMARY KEY,
    version BIGINT NOT NULL CHECK (version >= 0),
    decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_focus JSONB,
    pitfalls JSONB NOT NULL DEFAULT '[]'::jsonb,
    glossary JSONB NOT NULL DEFAULT '{}'::jsonb,
    constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
    policies JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_memory_projection (
    task_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    ownership JSONB NOT NULL DEFAULT '{}'::jsonb,
    progress JSONB NOT NULL DEFAULT '[]'::jsonb,
    blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
    verified_results JSONB NOT NULL DEFAULT '[]'::jsonb,
    handoffs JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY,
    project_id TEXT,
    memory_class TEXT NOT NULL,
    content_text TEXT NOT NULL,
    embedding vector,
    source_version BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursors (
    client_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_ingest_receipts (
    delivery_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    path TEXT NOT NULL,
    event_id UUID NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION memory_verification_status(p_event_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('memory.revoked', 'policy.revoked') THEN 'revoked'
        WHEN p_event_type IN ('memory.superseded', 'decision.superseded') THEN 'superseded'
        WHEN p_event_type = 'fact.contradicted' THEN 'contradicted'
        WHEN p_event_type IN ('fact.verified', 'task.verified') THEN 'verified'
        ELSE 'unverified'
    END;
$$;

CREATE OR REPLACE FUNCTION validate_memory_event_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_authority SMALLINT;
    current_version BIGINT;
BEGIN
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

CREATE OR REPLACE FUNCTION rebuild_project_memory_projection(p_project_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_last_sequence BIGINT;
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

    SELECT COALESCE(MAX(sequence), 0)
      INTO v_last_sequence
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
     WHERE project_id = p_project_id;

    SELECT content
      INTO v_current_focus
      FROM memory_entities
     WHERE project_id = p_project_id
       AND entity_type = 'focus'
       AND verification_status NOT IN ('superseded', 'revoked')
     ORDER BY updated_at DESC, entity_id DESC
     LIMIT 1;

    SELECT COALESCE(jsonb_object_agg(content->>'term', content->'value'), '{}'::jsonb)
      INTO v_glossary
      FROM memory_entities
     WHERE project_id = p_project_id
       AND entity_type = 'glossary'
       AND verification_status NOT IN ('superseded', 'revoked')
       AND content ? 'term'
       AND content ? 'value';

    INSERT INTO project_memory_projection (
        project_id, version, decisions, current_focus, pitfalls, glossary,
        constraints, policies, last_sequence, updated_at
    ) VALUES (
        p_project_id, v_last_sequence, v_decisions, v_current_focus, v_pitfalls,
        v_glossary, v_constraints, v_policies, v_last_sequence, now()
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

CREATE OR REPLACE FUNCTION apply_memory_event_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    next_version BIGINT;
BEGIN
    IF NEW.entity_id IS NOT NULL AND NEW.entity_type IS NOT NULL THEN
        SELECT COALESCE(current_version, 0) + 1
          INTO next_version
          FROM memory_entities
         WHERE entity_id = NEW.entity_id;
        next_version := COALESCE(next_version, 1);

        IF array_length(NEW.supersedes, 1) IS NOT NULL THEN
            UPDATE memory_entities
               SET verification_status = 'superseded', updated_at = NEW.created_at
             WHERE source_event_id = ANY(NEW.supersedes);
        END IF;

        INSERT INTO memory_entities (
            entity_id, entity_type, project_id, task_id, memory_class, authority,
            confidence, verification_status, title, content, source_event_id,
            current_version, created_at, updated_at
        ) VALUES (
            NEW.entity_id, NEW.entity_type, NEW.project_id, NEW.task_id,
            NEW.memory_class, NEW.authority, NEW.confidence,
            memory_verification_status(NEW.event_type),
            NULLIF(NEW.payload->>'title', ''), NEW.payload, NEW.event_id,
            next_version, NEW.created_at, NEW.created_at
        )
        ON CONFLICT (entity_id) DO UPDATE SET
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

CREATE OR REPLACE FUNCTION reject_memory_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'memory_events is append-only; append a corrective/superseding event instead';
END;
$$;

DROP TRIGGER IF EXISTS memory_events_validate_authority ON memory_events;
CREATE TRIGGER memory_events_validate_authority
BEFORE INSERT ON memory_events
FOR EACH ROW EXECUTE FUNCTION validate_memory_event_authority();

DROP TRIGGER IF EXISTS memory_events_apply_projection ON memory_events;
CREATE TRIGGER memory_events_apply_projection
AFTER INSERT ON memory_events
FOR EACH ROW EXECUTE FUNCTION apply_memory_event_projection();

DROP TRIGGER IF EXISTS memory_events_append_only ON memory_events;
CREATE TRIGGER memory_events_append_only
BEFORE UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION reject_memory_event_mutation();

COMMIT;
