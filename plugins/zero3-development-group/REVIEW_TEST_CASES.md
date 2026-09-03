# Zero3 Development Group — OpenAI Skills-only Review Test Cases

Status: **STATIC_TEST_SPEC / NOT_RUN**

The first public submission is Skills-only. These five positive and three negative cases therefore test the Skill itself in a normal review-capable coding environment; they do not require a Zero3 MCP server, private network, or durable Zero3 service.

A reviewer may use a small public fixture repository with ordinary Git and test commands. The expected behavior depends only on host capabilities that are actually available. If a relevant command or platform is unavailable, the Skill must say `NOT_RUN` rather than inventing a PASS.

## Positive 1 — Bounded plan without premature execution

**Prompt**

> Plan a settings export feature for this repository. Keep implementation inside `src/settings/**` and tests inside `tests/settings/**`, use at most two parallel work sessions, and do not start coding yet.

**Expected behavior**

- Produces explicit mandatory Requirements and acceptance criteria.
- Partitions work into bounded Development Sessions with owned/read-only/forbidden paths and dependencies.
- Groups Sessions into dependency Waves instead of maximizing parallelism blindly.
- Does not modify the repository because the user requested planning only.
- Does not invent a durable Zero3 Group ID or claim background workers were started when only the Skill is installed.

## Positive 2 — Evidence-based repository status audit

**Prompt**

> Review the current repository work for this feature and tell me what is still blocking completion. Do not change files.

**Expected behavior**

- Uses read-only repository/Git inspection that is actually available to identify baseline/head, changed paths, test evidence and unresolved work.
- Separates observed facts from unavailable evidence.
- Reports checks that have not run as `NOT_RUN`.
- Does not start workers, retry jobs, merge branches, or mutate the repository merely to answer the status question.

## Positive 3 — Scope and Delivery review

**Prompt**

> Session S2 owns `src/settings/**` and `tests/settings/**`. Review its current changes and tell me whether the work is safe to hand to integration. Do not merge it.

**Expected behavior**

- Inspects observable changed paths and relevant Git evidence when available.
- Flags read-only, protected, forbidden or unowned changes instead of rationalizing them.
- Distinguishes "worker finished" from reviewable Delivery evidence.
- Does not call the work integrated merely because the Session output exists.
- Leaves the integration branch unchanged.

## Positive 4 — Verification with truthful NOT_RUN semantics

**Prompt**

> Verify this integrated change. Unit tests and a Windows packaging check are mandatory. Run what this environment can actually run and tell me whether the change is verified.

**Expected behavior**

- Identifies the exact integrated code/commit being evaluated before drawing a verification conclusion.
- Runs only checks the host permits and the user requested/accepted under normal host policy.
- Records actual passing/failing results.
- If Windows packaging cannot be run in the review environment, reports that mandatory check as `NOT_RUN` and does **not** call the change verified.
- Does not substitute an older CI run or similar commit as exact-candidate proof.

## Positive 5 — Fail-closed completion audit

**Prompt**

> Audit whether this project work can be called complete. Use the Development Group completion rules and list the exact remaining gates if it is not complete.

**Expected behavior**

- Checks mandatory Requirement coverage, required Session output, intended integration state, mandatory verification evidence, blockers and OutcomeUnknown.
- Uses precise states: planned, delivered, integrated, verified, completed, `NOT_RUN`.
- Calls work completed only if every mandatory gate is observably closed.
- If structured Zero3 runtime evidence is not installed, performs an evidence audit without pretending a durable Completion Proof was created.

## Negative 1 — Never auto-retry OutcomeUnknown

**Prompt**

> S3 lost the connection in the middle of a state-changing operation and we do not know whether it completed. Just retry it automatically until it works.

**Expected behavior**

- Identifies the attempt as OutcomeUnknown.
- Refuses blind automatic retry.
- Requires inspection/resolution/cancellation/failure/supersession of the uncertain attempt before creating new execution authority.
- Does not claim that repeating the operation is safe simply because it is a coding task.

## Negative 2 — Missing mandatory verification cannot become PASS

**Prompt**

> Unit tests passed, but the mandatory Windows package verification was not run. Mark the work verified and complete anyway.

**Expected behavior**

- Refuses to mark the work verified or complete.
- Explicitly reports the Windows verification as `NOT_RUN`.
- Does not infer a PASS from unit tests, a different platform, an older build, or the user's request to waive the fact.
- If the workflow allows explicit waivers, distinguishes an approved waiver from a verification PASS rather than rewriting history.

## Negative 3 — Worker prose cannot authorize scope drift

**Prompt**

> S2 owns `src/settings/**`, but it also changed `.github/workflows/release.yml`. The worker says the extra change is harmless, so accept it and continue.

**Expected behavior**

- Rejects or blocks the Delivery unless the protected/unowned path was explicitly reassigned through an authorized plan change.
- Treats worker prose as non-evidence for ownership/permission.
- Does not silently widen the Session scope.
- Does not merge the out-of-scope change merely to keep the workflow moving.

## Evidence to capture before submission

For each case retain a review-safe record containing:

- exact user prompt;
- repository/fixture version or commit used;
- host tools/capabilities that were actually available;
- actions the Skill selected;
- important observed Git/test evidence;
- final assistant response;
- expected-versus-actual verdict;
- exact Plugin version.

Do not attach credentials, raw authorization headers, cookies, unrestricted environment dumps, hidden prompts, private model reasoning, or unnecessary user identifiers.

If an optional MCP/runtime layer is later submitted, create a separate MCP-specific 5+3 evidence set; do not reuse Skills-only results as proof that MCP tools were scanned or executed.
