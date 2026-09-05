# Zero3 Development Group — OpenAI Skills-only Submission Pack

Status: **DRAFT / NOT_SUBMITTED**

Submission type: **Skills only**.

This document is the release-owner checklist for the first public Zero3 Development Group Plugin submission. It deliberately excludes the optional MCP server from the first review.

## 1. Candidate identity

Record before submission:

- Plugin version: `0.1.0` unless intentionally bumped.
- Exact repository candidate SHA: `NOT_SET`.
- Plugin directory: `plugins/zero3-development-group/`.
- Manifest: `.codex-plugin/plugin.json`.
- Skill: `skills/development-group/SKILL.md`.
- Final integrated acceptance reference: `docs/DevelopmentGroup/FINAL_ACCEPTANCE.md`.

Do not submit from an uncommitted local edit or a different SHA than the evidence set.

## 2. Publisher identity and account authority

Record portal evidence; do not place private identity documents in the repository.

- Apps Management write access: `NOT_CONFIRMED`.
- Developer/business publisher verification: `NOT_CONFIRMED`.
- Publisher display name: `NOT_FINAL`.

## 3. Listing fields

Use real public destinations only. Never insert placeholder/fake domains.

- Display name: `Zero3 Development Group`.
- Category: `Developer Tools` (confirm against the current portal taxonomy).
- Short description: derive from the reviewed manifest; keep it concrete and non-inflated.
- Long description: explain bounded multi-session coding work, explicit evidence gates, truthful verification and fail-closed completion.
- Logo asset: `NOT_FINAL`.
- Product/company website: `NOT_SET`.
- Support URL/contact: `NOT_SET`.
- Privacy policy URL: `NOT_SET`.
- Terms URL: `NOT_SET / OPTIONAL_UNTIL_PORTAL_CONFIRMED`.
- Availability countries/regions: `NOT_SELECTED`.
- Release notes: `NOT_FINAL`.

Listing language must not claim:

- a public Zero3 MCP service is included in v1;
- background persistence exists merely because the Skill is installed;
- automatic parallel workers exist on a host that does not provide delegation;
- verification passes without actual exact-candidate evidence;
- Windows packaging/runtime acceptance is complete unless the final exact candidate passed it.

## 4. Starter prompts

Use prompts that work in Skills-only mode:

1. `Plan this coding goal into bounded Development Sessions and dependency waves without starting execution yet.`
2. `Review this repository work against the Development Group evidence gates and tell me what is still blocking completion.`
3. `Audit whether this coding work can be called verified, and clearly mark any required evidence that has not been run.`

Test each starter prompt on every ChatGPT/Codex surface selected for publication and retain review-safe evidence.

## 5. Required five positive + three negative cases

Source specification:

`plugins/zero3-development-group/REVIEW_TEST_CASES.md`

Capture for each case:

- exact prompt;
- exact candidate Plugin version/SHA;
- repository fixture/commit;
- host surface/model mode used by the reviewer test;
- host tools actually available;
- observable actions/evidence;
- final response;
- expected-versus-actual verdict;
- reviewer-safe screenshot or transcript if useful.

Do not count an authored specification as a test PASS. The result remains `NOT_RUN` until executed in the actual review-capable environment.

## 6. Privacy/data minimization review

For the Skills-only package confirm:

- the Skill itself contains no credentials or user data;
- it does not instruct the assistant to exfiltrate repository data;
- it does not require third-party services to perform the basic workflow;
- it does not expose hidden prompts or private reasoning as evidence;
- repository evidence is limited to what is needed for the user's coding task;
- logs/screenshots used in submission evidence contain no secrets, auth headers, cookies, access tokens or unrelated personal data.

If a future MCP version is submitted, repeat privacy review for MCP inputs/results and authentication separately.

## 7. Safety/behavior review

The first-review Skill must demonstrate:

- planning-only prompts do not mutate the repository;
- host sandbox/approval policies remain authoritative;
- worker prose cannot authorize scope drift;
- protected/read-only/unowned changes block acceptance unless explicitly reassigned;
- `OutcomeUnknown` is never automatically retried;
- `NOT_RUN` is never converted to PASS;
- integrated/verified/completed are distinct states;
- destructive operations follow the host's existing confirmation policy.

## 8. Submission form truthfulness

When the portal asks whether the Plugin uses MCP, select the **Skills only** submission route for v1.

Do not provide an MCP URL, OAuth configuration or tool annotations as if they were part of v1 merely because the repository also contains an experimental/Phase 2 MCP server.

If the portal/schema changes before submission, re-check the current official OpenAI Plugin documentation and update this pack before proceeding.

## 9. Release-owner final decision

Submission state remains `BLOCKED` until all of the following are true:

- exact candidate static/integrated acceptance evidence is closed to the level claimed by the listing;
- 5 positive + 3 negative Skills-only cases are executed and accepted internally;
- publisher identity/account authority is ready;
- required listing fields use real public assets/URLs;
- privacy/support/legal information is accurate;
- no unresolved review blocker is being hidden behind a waiver or inferred PASS.

After actual submission, record the portal submission ID/status outside this file if it contains private account information; only a non-sensitive release status may be committed here.

Official references reviewed 2026-09-04:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
