# Zero3 Memory Authority V2.1 Contract

Date: 2026-09-08

This document freezes the protocol boundary for the V2.1 multi-agent memory build.

## Authority

- AWS PostgreSQL `memory_events` is the cross-device shared-history authority.
- Structured Project/Task/Global memory is a rebuildable projection of events.
- pgvector is retrieval only and never decides which fact is authoritative.
- Pilot SQLite is offline cache, pending queue, and personal-local storage.
- GitHub Memory Inbox is append-only transport for Web GPT ingress, never a database.
- Provider-native Codex/Claude/Antigravity/Zero3 session memory is working memory only.

## Authority levels

| Class | Level |
|---|---:|
| user_decision | 100 |
| project_policy | 95 |
| system_policy | 95 |
| verified_result | 85 |
| merged_main_fact | 80 |
| agent_decision | 60 |
| agent_observation | 45 |
| external_observation | 40 |
| inference | 20 |
| unverified_note | 10 |

A lower-authority event cannot silently replace a higher-authority current entity.

## Provider memory boundary

Agent native context may preserve short-term continuity but cannot become a second Project Authority. On conflict, Zero3 authoritative context wins. Durable facts must pass through Memory Candidate -> Verification -> Promotion -> Memory Event.

## Failover minimum context

A replacement agent must be able to resume from Project Memory + Task Memory + Handoff + workspace/artifact references. Copying the previous provider's full chat is optional support, not a correctness dependency.

## Protocols

- `zero3.memory.event.v1`
- `zero3.memory.sync.v1`
- `zero3.memory.context-manifest.v1`

Schema files under `schemas/` are normative. Changes require versioning; do not mutate an already deployed meaning in place.
