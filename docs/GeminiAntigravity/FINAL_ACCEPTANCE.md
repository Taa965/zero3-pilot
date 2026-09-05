# Zero3 Pilot Gemini / Antigravity — Final Integrated Acceptance

Status: **NOT_RUN**

This is the single final truth acceptance plan for the GPT Web × Gemini Web × Antigravity × Codex integration. It is executed only after P01–P12 and the one-time integration wiring pass are merged onto one exact candidate SHA.

No authored test, static audit, earlier PR result, Linux result, another SHA, or agent self-report may be promoted into Windows/runtime PASS evidence.

## A. Exact candidate identity

Required evidence:

- one exact 40-character Git SHA;
- `HEAD` equals that SHA;
- repository clean before acceptance;
- acceptance transcript is stored outside the repository;
- no sibling parallel branch is a hidden runtime dependency.

Status: `NOT_RUN`.

## B. Static architecture gate

Run on the exact integrated candidate:

```text
node scripts/check-architecture.mjs
node scripts/check-gemini-antigravity-architecture.mjs
```

Must prove at minimum:

- Codex remains the default authoritative Agent Kernel;
- Gemini Web uses `persist:zero3-gemini`, never ChatGPT cookies/profile;
- Gemini Web transport does not use DOM click/type/scrape automation or private APIs;
- Antigravity is a bounded external-agent adapter around official `agy` behavior;
- explicit target routing never silently changes CODEX/GEMINI;
- task/review identities are durable and immutable where required;
- Git truth for Gemini worktrees is collected through the Codex authoritative command boundary;
- `OutcomeUnknown` remains fail-closed and cannot auto-retry;
- MCP is task/project scoped and cannot mutate ReviewDecision or CompletionGate;
- verification preserves `PASSED / FAILED / NOT_RUN / BLOCKED` truth states.

Status: `NOT_RUN`.

## C. Windows desktop preparation/typecheck/package

On Windows, against the same candidate SHA:

1. `npm --prefix apps/zero3-desktop run prepare`;
2. prove the prepared Electron tree contains Gemini Web, Antigravity, agent-routing, artifact, MCP and provider UI sources;
3. `npm --prefix apps/zero3-desktop run typecheck`;
4. optionally build the Windows installer during the same run using `-BuildInstaller`;
5. reset generated pinned-upstream overlays after evidence capture;
6. prove the repository returns clean.

Status: `NOT_RUN`.

## D. Real browser/login isolation

Run the packaged or exact-candidate desktop application on Windows.

Required evidence:

- ChatGPT Web opens in its existing persistent profile and remains logged in if previously authenticated;
- Gemini Web opens in the separate `persist:zero3-gemini` profile;
- Gemini login can be completed normally through the real Google/Gemini surface;
- logging in/out of Gemini does not log ChatGPT in/out and vice versa;
- only credential-free Gemini URL/title/conversation bindings are persisted by Zero3;
- no OAuth URL, Cookie, access token, refresh token, authorization header, or credential cache secret appears in Zero3 task/project state or acceptance transcript.

Status: `NOT_RUN`.

## E. Real GPT → Gemini implementation → GPT review loop

Use a disposable repository/worktree fixture first.

Required flow:

1. create or open a GPT Web logical session;
2. create a TaskSpecV2 explicitly targeted to `GEMINI`;
3. Zero3 creates/binds a dedicated Gemini logical session and isolated writable worktree;
4. Antigravity receives the task through the official `agy` runtime adapter;
5. progress/result candidates may be published through the task-scoped MCP gateway;
6. authoritative Git/artifact/verification evidence is collected independently of agent prose;
7. ExecutionResultV2 is materialized;
8. ReviewPacket is surfaced to GPT/reviewer;
9. issue `CHANGES_REQUESTED` with at least one required fix;
10. prove the FixRequest preserves the same logical Gemini session and, where supported, the same runtime conversation id;
11. run the fix cycle and produce a new immutable review cycle;
12. approve only after required completion evidence is present.

Status: `NOT_RUN`.

## F. Codex target and AUTO routing

Required evidence:

- an explicit `CODEX` implementation task remains CODEX and is never silently redirected to Gemini;
- an explicit `GEMINI` task fails visibly if Gemini is unavailable/unauthenticated rather than silently moving to Codex;
- AUTO routing records its reason;
- implementation/verification/fix/integration prefers Codex when eligible;
- design/research/review prefers Gemini when eligible;
- fallback occurs only for AUTO and remains observable.

Status: `NOT_RUN`.

## G. Worktree / Git / artifact truth

Required evidence:

- writable Gemini task starts from the requested clean base SHA;
- Gemini and Codex never share one writable task worktree concurrently;
- changed files are derived from authoritative Git evidence rather than model prose;
- content-addressed artifacts verify against their stored SHA-256 metadata;
- a deliberately modified artifact fails verification;
- required verification left unexecuted remains `NOT_RUN`, never PASS;
- CompletionGate cannot be satisfied by `task_publish_result` alone.

Status: `NOT_RUN`.

## H. OutcomeUnknown, restart and recovery

Required destructive fixture:

1. start a state-changing Gemini task;
2. terminate the Antigravity process or desktop before a terminal result;
3. prove the task becomes durable `OUTCOME_UNKNOWN`;
4. restart Zero3 Pilot;
5. prove no automatic retry/new authority is created;
6. inspect runtime status, Codex Git evidence and artifact presence;
7. explicitly classify the task using the recovery path;
8. prove retry remains blocked while `OUTCOME_UNKNOWN` is unresolved;
9. prove runtime conversation/worktree identity is not silently replaced during classification.

Status: `NOT_RUN`.

## I. MCP lease lifecycle and security

Required evidence:

- task MCP lease is scoped by task id, project id and state/artifact/review roots;
- another task/project id is rejected;
- agent can read task/context/artifacts/review and publish only progress/result candidates;
- no arbitrary command/shell tool exists;
- agent cannot write ReviewDecision or CompletionGate;
- task MCP lease/configuration is removed/reverted after the task lifecycle;
- no credentials are copied into MCP environment/state beyond required non-secret scope identifiers/paths.

Status: `NOT_RUN`.

## J. Final release rule

Gemini/Antigravity V1 may be marked **ACCEPTED** only when sections A–I have evidence for the same exact candidate SHA and no required item remains `NOT_RUN`, `FAILED`, `BLOCKED` or `OUTCOME_UNKNOWN`.

The automated PowerShell runner closes only the automatable Windows/static/package subset. Browser login, real task/review, process-kill recovery, worktree truth and credential review remain explicit real-runtime gates until recorded.
