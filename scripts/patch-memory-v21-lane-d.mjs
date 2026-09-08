import fs from 'node:fs'

const libFile = 'crates/zero3-memory/src/lib.rs'
let lib = fs.readFileSync(libFile, 'utf8')
const marker = `//! promote an observation into long-term personal memory.\n\n`
if (!lib.includes('pub mod sync_queue;')) {
  if (!lib.includes(marker)) throw new Error('lane D patch drift: zero3-memory module marker')
  lib = lib.replace(marker, `${marker}pub mod sync_queue;\n\n`)
  fs.writeFileSync(libFile, lib)
}

const testFile = 'crates/zero3-memory/tests/sync_queue.rs'
let test = fs.readFileSync(testFile, 'utf8')
const oldPrefix = `#[path = "../src/sync_queue.rs"]\nmod sync_queue;\n\nuse serde_json::json;\nuse sync_queue::{PendingState, SqliteSyncQueue};`
const newPrefix = `use serde_json::json;\nuse zero3_memory::sync_queue::{PendingState, SqliteSyncQueue};`
if (!test.includes(newPrefix)) {
  if (!test.includes(oldPrefix)) throw new Error('lane D patch drift: integration test import')
  test = test.replace(oldPrefix, newPrefix)
  fs.writeFileSync(testFile, test)
}
