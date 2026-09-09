\set ON_ERROR_STOP on
BEGIN;
INSERT INTO memory_events(event_id,project_id,task_id,agent_id,agent_type,event_type,memory_class,authority,entity_type,entity_id,expected_entity_version,payload,source_type,created_at)
VALUES('88888888-0000-4000-8000-000000000001','identity-a','identity-task','test','codex','task.progress','task',60,'task','progress',0,'{}','task',now());
DO $$ BEGIN
  BEGIN
    INSERT INTO memory_events(event_id,project_id,task_id,agent_id,agent_type,event_type,memory_class,authority,entity_type,entity_id,expected_entity_version,payload,source_type,created_at)
    VALUES('88888888-0000-4000-8000-000000000001','identity-a','identity-task','test','codex','task.progress','task',60,'task','progress',0,'{"changed":true}','task',now())
    ON CONFLICT(event_id) DO NOTHING;
    RAISE EXCEPTION 'expected payload conflict';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM <> 'event_id_payload_conflict' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO memory_events(event_id,project_id,task_id,agent_id,agent_type,event_type,memory_class,authority,entity_type,entity_id,expected_entity_version,payload,source_type,created_at)
    VALUES('88888888-0000-4000-8000-000000000002','identity-b','identity-task','test','codex','task.progress','task',60,'task','other',0,'{}','task',now());
    RAISE EXCEPTION 'expected task project binding';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'task_project_mismatch' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
