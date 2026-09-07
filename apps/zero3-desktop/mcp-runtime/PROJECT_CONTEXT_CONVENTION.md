# Zero3 Project Context Convention

`project_put_context` intentionally accepts an evolvable JSON payload. Writers should keep the canonical memory small and limited to facts that cannot be reconstructed reliably from the repository itself.

Recommended v1 shape:

```ts
{
  version: 1,
  decisions: Array<{ at: string; text: string; by: string }>,
  currentFocus: string | null,
  pitfalls: Array<{ text: string; at: string }>,
  glossary: Record<string, string>
}
```

Do not mirror source trees, dependency graphs, generated code, or other repository facts into project memory. Re-read the current context before every write and supply `expectedVersion`; a version conflict must be resolved by reading and merging, never by blind overwrite.

Codex sessions are scoped to the active Zero3 project through `ZERO3_ACTIVE_PROJECT_ID`. When that environment variable is present, project-context reads and writes for every other project id are rejected fail-closed. A Codex thread started without an active project receives an unassigned sentinel scope, so it cannot reach a real project's memory.
