# OpenAI Plugin Review Readiness — Zero3 Development Group

Status: **NOT_READY_FOR_PUBLIC_SUBMISSION**

First submission mode: **Skills only**.

OpenAI's current Plugin submission flow supports Skills-only Plugins independently from Plugins that include MCP. The first Zero3 Development Group review therefore does not depend on a public MCP URL, OAuth, MCP tool scan, or remote Zero3 service. Those capabilities are Phase 2 and must not be inferred from the skills-only package.

## Scope freeze for first review

Included:

- explicit Requirement and acceptance-criteria normalization;
- bounded Development Sessions and dependency Waves;
- scope/ownership review;
- observable Git/evidence review when repository tools are available;
- explicit distinction between delivered, integrated, verified, completed, and `NOT_RUN`;
- OutcomeUnknown fail-closed handling;
- fail-closed completion audit.

The Skill may use host-native coding, Git, test, and delegation capabilities when they are actually available. It must follow the host's existing sandbox/approval rules and must not claim Zero3 persistence or structured records unless a real Zero3 runtime is installed.

Excluded from the first review surface:

- required dependency on a Zero3 MCP server;
- generic shell/arbitrary-command products exposed as a Plugin capability;
- browser/computer control;
- credential management;
- arbitrary provider switching;
- Claude/Hermes/ACP dispatch marketing;
- remote publishing/deployment;
- generic Renderer -> Codex RPC;
- destructive admin operations;
- claims of background persistence when only the Skill is installed.

## Repository/static gates

- [x] Stable plugin identity: `zero3-development-group`.
- [x] Required `.codex-plugin/plugin.json` exists.
- [x] First-review package has no mandatory MCP/App dependency.
- [x] Bundled Skill is independently useful in skills-only mode.
- [x] Skill requires observable evidence before `verified`/`completed` claims.
- [x] `NOT_RUN` cannot be translated into PASS.
- [x] OutcomeUnknown is explicitly non-retryable without resolution.
- [x] Scope drift is rejected rather than justified from worker prose.
- [x] Five positive and three negative skills-only review cases are documented.
- [ ] Development Group runtime/desktop closeout is merged and statically re-reviewed on one integration head.
- [ ] Final exact-candidate static architecture gate is executed by the release owner/local agent.
- [ ] Final Windows integrated acceptance is executed externally on the exact candidate SHA if Windows product claims are included in listing/release notes.

## Publisher and listing gates

These are account/publication facts and cannot be claimed from repository code:

- [ ] Submitter has Apps Management write access required by the OpenAI submission portal.
- [ ] Developer/business publisher identity is verified.
- [ ] Final display name, short/long description, category, logo and starter prompts are accepted in the submission draft.
- [ ] Public product/company website URL exists.
- [ ] Public support URL/contact exists as required by the listing.
- [ ] Public privacy policy URL exists and accurately describes data handled by the skills-only workflow and any optional host/runtime integration.
- [ ] Terms of service URL exists if included/required for the listing.
- [ ] Supported countries/regions match actual product/support/legal readiness.
- [ ] No placeholder legal or company URL is inserted merely to satisfy a form.

## Skills-only review evidence gates

- [ ] All five positive cases are executed in the intended review-capable ChatGPT/Codex environment and behave as specified.
- [ ] All three negative cases fail closed as specified.
- [ ] Review evidence shows what host tools were actually available for each case.
- [ ] Cases that cannot run a required check report `NOT_RUN` rather than passing it by inference.
- [ ] Starter prompts are tested on every OpenAI surface selected for release.
- [ ] Reviewer instructions use a repository fixture that is accessible without a private network, hidden credential, MFA-only flow, or private Zero3 service.
- [ ] Final release notes accurately describe the initial package as a Skills-only evidence-gated workflow and do not claim the optional MCP/runtime layer is part of the public submission.

## Phase 2 — optional MCP/runtime expansion

These gates are **not blockers for the first Skills-only submission**. They become mandatory only when a later Plugin version is submitted **with MCP**:

- [ ] Production HTTPS MCP URL is stable and publicly reachable by OpenAI reviewers.
- [ ] MCP connection/app metadata is added using the then-current Plugin packaging format.
- [ ] Tool scan returns only the intended Development Group tools.
- [ ] Tool names, descriptions, input schemas and annotations match actual behavior.
- [ ] `readOnlyHint`, `openWorldHint`, `destructiveHint` and related annotations are accurate per tool.
- [ ] Tool output is audited for credentials, PII, debug payloads, internal exceptions and unnecessary repository data.
- [ ] OAuth/reviewer credentials meet OpenAI review requirements if authentication is used.
- [ ] MCP-specific five-positive/three-negative cases pass against the production endpoint.

The repository may contain a Phase 2 MCP implementation before these items are complete. Its presence does not make it part of the first public Plugin submission.

## Submission decision

The first public submission is permitted only when every applicable **repository/static**, **publisher/listing**, and **skills-only review evidence** gate above is closed. Phase 2 MCP gates remain explicitly out of first-review scope.

A local install, authored test, static code review, optional MCP prototype, or successful Windows build is not equivalent to OpenAI approval readiness.

Reference baseline reviewed on 2026-09-04:

- every Plugin requires `.codex-plugin/plugin.json`;
- Plugin bundles may contain Skills, MCP, or both;
- the public submission flow explicitly supports **Skills only** and **With MCP** as separate submission types;
- a public MCP URL and MCP annotations are required for MCP-backed submissions, not for a Skills-only submission;
- the submission flow requires five positive and three negative test cases.

Official references:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
