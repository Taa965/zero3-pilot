BEGIN;

-- Rust MemoryEvent uses f64 for confidence. tokio-postgres performs strict
-- parameter/result type checks, so PostgreSQL float4 (REAL) is not compatible
-- with Option<f64>. Standardize both authoritative/current-state columns on
-- DOUBLE PRECISION while preserving the existing 0..1 constraints.
ALTER TABLE memory_events
  ALTER COLUMN confidence TYPE DOUBLE PRECISION
  USING confidence::DOUBLE PRECISION;

ALTER TABLE memory_entities
  ALTER COLUMN confidence TYPE DOUBLE PRECISION
  USING confidence::DOUBLE PRECISION;

COMMIT;
