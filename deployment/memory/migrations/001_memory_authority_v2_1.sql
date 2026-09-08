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
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    entity_type TEXT,
    entity_id TEXT,
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
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
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

CREATE OR REPLACE FUNCTION reject_memory_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'memory_events is append-only; append a corrective/superseding event instead';
END;
$$;

DROP TRIGGER IF EXISTS memory_events_append_only ON memory_events;
CREATE TRIGGER memory_events_append_only
BEFORE UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION reject_memory_event_mutation();

COMMIT;
