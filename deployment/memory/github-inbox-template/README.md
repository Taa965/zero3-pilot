# Zero3 Memory Inbox template

This directory is copied into a **separate private repository** used only as the Web ChatGPT -> Zero3 Memory Authority delivery inbox.

Recommended repository: `Taa965/zero3-memory-inbox` (private).

## Required repository secrets

- `ZERO3_MEMORY_AUTHORITY_URL` — e.g. `https://memory.example.com`
- `ZERO3_MEMORY_INGRESS_TOKEN` — a Memory Authority bearer grant restricted to:
  - `agent_types = ["gpt_web"]`
  - `max_authority = 60`
  - `allow_personal = false`
  - `allow_global = false`
  - the intended project ids (or `*` only if project creation is separately controlled)

Never place the token, AWS credentials, cookies, API keys or any other credential in an event file.

## Repository layout

```text
.github/workflows/relay-memory-event.yml
scripts/validate-memory-event.mjs
events/
  <project_id>/
    YYYY/
      MM/
        <event_uuid>.json
```

Each event is a new immutable file. Existing `events/**` files must never be edited, renamed or deleted. The relay workflow fails closed if it sees anything except an `A` (added) change for an event path.

## ChatGPT write contract

At task close, Web GPT may create:

1. one `task.completed`/task-ledger event when relevant;
2. zero or more durable project-memory candidates that passed distillation.

For GitHub ingress:

- `schema` must be `zero3.memory.event.v1`;
- `scope.project_id` must equal the project directory in the path;
- `actor.agent_type` must be `gpt_web`;
- `source.type` must be `github_inbox`;
- `memory.authority` must be 0..60;
- `memory.class=personal` is forbidden;
- secret-like keys/values are rejected before relay;
- a single event file is capped at 256 KiB.

The AWS Memory Authority performs its own authentication, project ACL, authority and event-idempotency checks again. The GitHub validator is defense in depth, not the authority boundary.

## Idempotency

GitHub Actions may be retried. This is safe because `event_id` is the Memory Authority idempotency key. An already committed event returns `status=duplicate` and is treated as success by the relay.
