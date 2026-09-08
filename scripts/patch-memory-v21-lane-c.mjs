import fs from 'node:fs'

const file = 'apps/memory-server/src/lib.rs'
let source = fs.readFileSync(file, 'utf8')

const oldSetup = `        let authority = i16::from(event.memory.authority);\n        let supersedes = event.supersedes.clone();`
const newSetup = `        let authority = i16::from(event.memory.authority);\n        let expected_entity_version = event\n            .memory\n            .expected_entity_version\n            .map(i64::try_from)\n            .transpose()\n            .context("expected entity version exceeds PostgreSQL bigint")?;\n        let supersedes = event.supersedes.clone();`
if (!source.includes(newSetup)) {
  if (!source.includes(oldSetup)) throw new Error('lane C patch drift: append setup')
  source = source.replace(oldSetup, newSetup)
}

const oldSql = `entity_type, entity_id, supersedes, payload, source_type, source_ref, source_hash, created_at) VALUES ($1::text::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[]::uuid[],$16,$17,$18,$19,$20::text::timestamptz)`
const newSql = `entity_type, entity_id, expected_entity_version, supersedes, payload, source_type, source_ref, source_hash, created_at) VALUES ($1::text::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text[]::uuid[],$17,$18,$19,$20,$21::text::timestamptz)`
if (!source.includes(newSql)) {
  if (!source.includes(oldSql)) throw new Error('lane C patch drift: insert SQL')
  source = source.replace(oldSql, newSql)
}

const oldParams = `                &event.memory.entity_type, &event.memory.entity_id, &supersedes, &event.payload,\n                &event.source.kind, &event.source.r#ref, &event.source.hash, &event.created_at,`
const newParams = `                &event.memory.entity_type, &event.memory.entity_id, &expected_entity_version, &supersedes,\n                &event.payload, &event.source.kind, &event.source.r#ref, &event.source.hash,\n                &event.created_at,`
if (!source.includes(newParams)) {
  if (!source.includes(oldParams)) throw new Error('lane C patch drift: insert params')
  source = source.replace(oldParams, newParams)
}

fs.writeFileSync(file, source)
