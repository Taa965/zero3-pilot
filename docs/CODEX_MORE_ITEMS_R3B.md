# Codex native Item projection — R3B

R3B extends the R3A presentation adapter. It does **not** add another Agent runtime and it does not change the Codex Thread / Turn / Item authority model.

Pinned protocol source: `upstream/codex` at the SHA declared by `apps/zero3-desktop/scripts/config.mjs`.

## Visible native Items

### `dynamicToolCall`

Zero3 projects the native Item into a generic Hermes-derived tool card. The card preserves:

- `namespace`;
- `tool`;
- JSON arguments;
- native `inProgress | completed | failed` status;
- text output from `contentItems[type=inputText]`;
- original output content items for inspection;
- `success` and duration.

This is a **presentation mapping only**. On the pinned Codex protocol, actual client-hosted dynamic-tool execution arrives as the server request `item/tool/call` with `DynamicToolCallParams` and expects a `DynamicToolCallResponse`. R3B does not register or execute arbitrary dynamic tools, so that server-request class continues to be rejected by the existing fail-closed dispatcher until a dedicated tool-registration, permission and execution boundary is implemented.

### `plan`

Pinned Codex TUI treats proposed plans as user-visible transcript content. Zero3 therefore renders a Plan card rather than discarding the Item or treating it as private reasoning.

### `webSearch`

Zero3 maps the native `webSearch` Item to the existing Hermes-derived `web_search` presentation. Query, action and result rows stay attached to the Codex Item id and therefore work for both restored history and live Item lifecycle events.

## Intentionally hidden Item: `functionCallOutput`

Pinned Codex TUI does not dump ordinary `functionCallOutput` rows into transcript history. It only surfaces a narrow delegated-tool form after a dedicated parser validates that output.

Zero3 keeps the same safe default. Generic function-call output can contain opaque data, media references or `encrypted_content`; R3B does not serialize that payload directly into the visible transcript. A future delegated-tool/collaboration adapter may expose a validated subset with its own parser and tests.

## Runtime and safety invariants

- Open-source Codex remains the sole Agent Kernel.
- Hermes remains a presentation shell; its Python runtime is not used for these Items.
- Zero3 Node is not used by this path.
- No generic Renderer JSON-RPC proxy is added.
- R2B server-request approval/input handling remains authoritative.
- Unsupported server requests remain fail-closed.
- Default sandbox remains `read-only` in this phase.

## Deferred after R3B

The next execution-parity work includes structured user attachments, permission-profile and MCP elicitation UX, native thread archive/delete/fork/revert/steer/edit operations, and dedicated dynamic-tool registration/execution if Zero3 needs client-hosted tools.
