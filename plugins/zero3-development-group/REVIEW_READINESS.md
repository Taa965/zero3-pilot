# OpenAI Plugin Review Readiness — Zero3 Development Group

Status: **NOT_READY_FOR_PUBLIC_SUBMISSION**

This file is the authoritative pre-submission checklist for the first public Zero3 Development Group plugin. It separates repository/static readiness from claims that require a real deployed MCP endpoint or account-side OpenAI submission evidence.

## Scope freeze for v1 review

Included:

- persistent Development Group planning;
- bounded Development Sessions and dependency waves;
- Delivery validation;
- controlled integration;
- exact-SHA verification;
- repair attribution/budgets;
- fail-closed Completion Proof.

Excluded from the first review surface:

- generic shell or arbitrary command execution;
- browser/computer control;
- credential management;
- arbitrary provider switching;
- Claude/Hermes/ACP marketing or dispatch tools;
- remote publishing/deployment;
- generic Renderer -> Codex RPC;
- delete/force-reset/irreversible admin tools.

## Repository/static gates

- [x] Stable plugin identity: `zero3-development-group`.
- [x] Required `.codex-plugin/plugin.json` exists.
- [x] Bundled skill exists under `skills/`.
- [x] Review-facing MCP tool contract is narrow and documented.
- [x] Read/write/destructive/open-world annotation intent is documented per tool.
- [x] OutcomeUnknown is explicitly non-retryable without human resolution.
- [x] Completion semantics are fail-closed rather than based on worker prose.
- [x] Positive and negative review test cases are documented.
- [ ] Development Group P06-P10 are merged and statically re-reviewed on one integration head.
- [ ] Final Windows integrated acceptance is executed externally on the exact candidate SHA.

## Public MCP gates

These cannot be claimed from the current repository alone:

- [ ] Production HTTPS MCP server URL exists and is publicly reachable by OpenAI reviewers.
- [ ] Tool scan returns exactly the intended v1 tool list.
- [ ] Tool names, titles, descriptions, schemas and annotations match actual behavior.
- [ ] Every tool exposes accurate `readOnlyHint`, `openWorldHint`, and `destructiveHint` values.
- [ ] MCP server instructions are bounded to the published Development Group workflow.
- [ ] Tool results are audited for unnecessary personal data, auth secrets, debug payloads and internal identifiers.
- [ ] If OAuth is used, reviewer credentials work without MFA/SMS/email-confirmation/private-network dependency and the authorization server meets OpenAI identity requirements.
- [ ] UI, if later added, has exact CSP domains. The initial submission should remain UI-free unless UI materially improves the workflow.

## Publisher/legal gates

- [ ] Submitter has the required Apps Management write access.
- [ ] Developer/business publisher identity is verified in the OpenAI submission portal.
- [ ] Public product/company URL is available.
- [ ] Public privacy policy URL is available and accurately describes data handled by the MCP server.
- [ ] Terms of service URL is available if used in the listing.
- [ ] Supported countries/regions are selected only where product/support/legal readiness exists.

Do not insert placeholder legal URLs into `plugin.json`; add them only when real public pages exist.

## Review evidence gates

- [ ] All five positive test cases pass against the production MCP endpoint.
- [ ] All three negative test cases fail closed as specified.
- [ ] Test prompts and expected responses are copied into the OpenAI submission draft.
- [ ] Starter prompts are tested on every supported ChatGPT/Codex surface selected for release.
- [ ] Reviewer setup notes describe any required repository fixture without requiring private-network access.
- [ ] Final release notes accurately state this is an initial submission and disclose any known limitations.

## Submission decision

Public submission is permitted only when every unchecked public MCP, publisher/legal, review-evidence, and final integrated-acceptance gate above is closed. A local plugin install or successful static review is not equivalent to OpenAI approval readiness.

Reference baseline reviewed on 2026-09-04:

- OpenAI plugin packaging requires `.codex-plugin/plugin.json` and supports bundled skills/MCP resources.
- Public submission requires a public production MCP URL for MCP-backed plugins, accurate tool metadata/annotations, reviewer-accessible setup, and five positive plus three negative test cases.

Official references:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
