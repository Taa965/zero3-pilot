#!/usr/bin/env bash
set -euo pipefail

first_event='66666666-6666-4666-8666-666666666666'
second_event='77777777-7777-4777-8777-777777777777'

psql -v ON_ERROR_STOP=1 <<SQL &
BEGIN;
INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '$first_event', 'project-race', 'codex-a', 'codex',
  'decision.recorded', 'project', 60, 'decision', 'decision-race', 0,
  '{"text":"first writer"}'::jsonb, 'task', now()
);
SELECT pg_sleep(2);
COMMIT;
SQL
first_pid=$!

sleep 0.25
set +e
second_output="$({ psql -v ON_ERROR_STOP=1 <<SQL
INSERT INTO memory_events (
  event_id, project_id, agent_id, agent_type, event_type, memory_class,
  authority, entity_type, entity_id, expected_entity_version, payload,
  source_type, created_at
) VALUES (
  '$second_event', 'project-race', 'claude-b', 'claude',
  'decision.recorded', 'project', 60, 'decision', 'decision-race', 0,
  '{"text":"stale concurrent writer"}'::jsonb, 'task', now()
);
SQL
} 2>&1)"
second_status=$?
set -e

wait "$first_pid"

if [[ "$second_status" -eq 0 ]]; then
  echo 'second version-zero writer unexpectedly succeeded' >&2
  exit 1
fi

grep -q 'entity_version_conflict' <<<"$second_output"

count="$(psql -Atqc "SELECT count(*) FROM memory_entities WHERE scope_key='project:project-race' AND entity_id='decision-race'")"
version="$(psql -Atqc "SELECT current_version FROM memory_entities WHERE scope_key='project:project-race' AND entity_id='decision-race'")"
content="$(psql -Atqc "SELECT content->>'text' FROM memory_entities WHERE scope_key='project:project-race' AND entity_id='decision-race'")"

[[ "$count" == '1' ]]
[[ "$version" == '1' ]]
[[ "$content" == 'first writer' ]]

echo 'Memory Authority concurrent version-zero write serialization passed'
