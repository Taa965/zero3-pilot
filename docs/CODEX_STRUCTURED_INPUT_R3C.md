# Codex structured user input — R3C

R3C replaces the R2A text-only submit boundary with a strictly typed adapter from the Hermes-derived composer into the pinned open-source Codex `turn/start` `UserInput[]` protocol.

Pinned protocol source: `upstream/codex` at the SHA declared by `apps/zero3-desktop/scripts/config.mjs`.

## Architecture role

R3C does not introduce a new runtime. The path remains:

```text
Hermes-derived Composer
        ↓
Zero3 presentation/input adapter
        ↓
typed Electron preload IPC
        ↓
Codex app-server turn/start
        ↓
open-source Codex core
```

Open-source Codex remains the sole Agent Kernel. Zero3 Node and Hermes Runtime are not used for primary chat submission or attachment staging.

## Renderer-sendable native input

The pinned Codex protocol supports a wider `UserInput` union, including `text`, `image`, `localImage`, `audio`, `localAudio`, `skill`, and `mention`. R3C deliberately exposes only the subset required by the current desktop composer:

- `text` — normalized model-facing text/context;
- `localImage` — a local image path already selected or persisted by the desktop shell.

Electron main reconstructs every outgoing input object and rejects every other type. The Renderer therefore does not receive a generic `UserInput` or JSON-RPC escape hatch.

The runtime limits in this phase are:

- at most 32 input items per Turn;
- at most 100,000 characters per individual text item;
- at most 4,096 characters per local image path;
- exactly one of legacy `text` or structured `input[]` at the typed `turn/start` boundary.

The legacy text form remains only for compatibility with already-reviewed Zero3 callers. It is normalized by Electron main into the same Codex `{ type: 'text', text, text_elements: [] }` form before transmission.

## Composer attachment mapping

### Images

Hermes-derived image pick, paste, and drop flows persist the source to a local path before submit. R3C maps those images to native Codex:

```text
{ type: 'localImage', path }
```

An image attachment without a usable local path is rejected before `turn/start`; it is never silently omitted. The composer submit engine restores a rejected draft and its cloned attachments.

### Files and folders

Codex `mention` is not a generic local-file attachment primitive. In the pinned implementation it is used for resolved plugin/app/task-style bindings. R3C therefore does **not** invent `mention` objects for files or folders.

File and folder attachments become explicit text context containing the selected path. Codex remains responsible for reading that path through its own file/tool capabilities under the active sandbox.

### URLs and review context

URL and resolved PR-review attachments remain text context. Review attachments reuse the Hermes-derived presentation parser to preserve author, anchor, body, and diff-hunk context when available. This is data transformation only; no Hermes Agent runtime call is made during Codex Turn submission.

### Terminal selections

Hermes desktop stores terminal selections locally and inserts an `@terminal:` reference into the draft. R3C reuses the shell's pure `terminalContextBlocksFromDraft()` lookup to append the saved terminal text to the Codex text input. It does not execute a Hermes terminal tool or route the Turn through Hermes Runtime.

## History and optimistic presentation

The optimistic user bubble keeps Hermes-derived attachment rendering. Restored Codex `userMessage` Items project native `localImage` and remote `image` entries back into attachment references for presentation, while text entries return to normal user-message text.

Remote `image` is accepted only as historical Codex data in this phase; the Zero3 Renderer cannot submit a remote `image` input through the R3C typed boundary.

## Safety invariants

- Open-source Codex remains the sole core runtime.
- The Renderer cannot choose a Codex executable or invoke arbitrary app-server methods.
- Structured Turn input is allowlisted and reconstructed in Electron main.
- Unsupported UserInput variants are rejected, not forwarded.
- No `skill`, `mention`, `audio`, `localAudio`, or remote `image` emitter is added in R3C.
- No Hermes Runtime attachment staging is used.
- No Zero3 Node route is used.
- Default Codex sandbox remains `read-only` in this phase.
- Existing R2B approval/user-input server-request handling remains authoritative.
- Unsupported Codex server requests remain fail-closed.

## Deferred

Later phases can add native Codex capabilities only behind dedicated protocol and permission UX. Candidates include validated skill/plugin mentions, audio input, thread archive/delete/fork/revert/steer/edit operations, and client-hosted dynamic-tool registration.

`thread/revert` must be presented carefully when implemented: it rewinds persisted conversation history; it does not restore or undo files changed on disk.
