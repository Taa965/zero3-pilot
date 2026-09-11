# Task workspace acceptance — 2026-09-11

The previous TaskList/TaskWorkspace were static demo components: one invented task, inactive filters and review buttons, six unfinished tabs, and an invented passing typecheck. The task module now reads and mutates the existing persistent Execution Runtime.

## Implemented

- Shared selection and refresh state across the task list and workspace; loading, empty, incompatible-data and disconnected states.
- Task creation with project association, goal, executor and sequential initial steps; dynamic step addition with a dependency.
- Text/project/status filters including review, exception and completed tasks. Step-level attention is visible even when the parent task is running.
- Assignment creation, real session ID binding, resume, submission for review, blocking, human intervention and cancellation with a required explanation.
- Overview, execution, code changes, artifacts, verification, review and chronological event history backed by durable records. Raw payloads are available in expandable details.
- Human review records its evidence, verifies the current assignment and checks required output records. Rejection returns the step for revision. Completion releases dependencies; wholly cancelled/mixed cancelled-and-completed work closes as cancelled.
- Runtime enforcement of dependency readiness, executor compatibility, concurrency and completion-gate authority; UI controls do not write state locally. A manual transition to ready is rejected while dependencies are unfinished, so a waiting step cannot be moved past its dependencies.
- A step whose dependency was cancelled stays waiting and explains that it cannot start; cancelling it closes the task when every step is terminal.

## Validation

Run the existing runtime/reporter/desktop tests and new task behavior tests:

```sh
node --experimental-transform-types --test apps/zero3-desktop/execution-runtime/execution-runtime.test.ts apps/zero3-desktop/execution-runtime/execution-reporter.test.ts apps/zero3-desktop/execution-runtime/execution-desktop-runtime.test.ts apps/zero3-desktop/tests/task-workspace.test.ts
```

The browser acceptance uses a temporary real desktop runtime/store, the production React components, Tailwind classes and a separate headless browser. It checks creation, persistence/reload, assignment/binding, progress/artifacts, reject/approve, dependency release, seven tabs, searching/filtering, human/block actions, cancelled-dependency guidance and disconnected behavior. It does not access user tasks or sessions.

```powershell
$env:ZERO3_TEST_BROWSER_CHANNEL = 'msedge'
# Optional: point to another installed pinned Hermes workspace when testing in a worktree.
$env:ZERO3_UI_TEST_DEPENDENCIES = 'C:/path/to/upstream/hermes-agent'
node --experimental-transform-types apps/zero3-desktop/tests/task-workspace.browser.mjs
```

Screenshots are written to ignored `output/task-workspace/`. Task component TypeScript validation passed against the installed desktop React/TypeScript dependencies. A full renderer check against the existing prepared desktop did not pass: that prepared tree has stale web-provider/skills declarations and missing dependency/fixture resolution. This is not a packaged Electron release acceptance.

## Integration boundaries

The task workspace controls and observes the macro Execution Runtime. Assignment creation does not automatically launch an external AI app or send its goal. Existing worker/executor integrations remain responsible for actual execution and signed reporter callbacks. Session binding records an existing logical session ID, not proof that the application is connected.

Artifacts and verification show recorded evidence. Physical download/archival of remote binaries and automatic production of Git diffs are separate integrations; empty evidence is shown explicitly. The UI does not synthesize passing checks, completed work, files or reviews.
