# Zero3 owned three-column renderer

This directory is the only maintained Zero3 Pilot desktop product renderer.

## Runtime boundary

The renderer does not implement an agent loop. It consumes purpose-specific preload bridges already owned by the desktop runtime:

- `zero3Codex`: open-source Codex app-server lifecycle, Thread/Turn/Item state, interruption and server-request responses;
- `zero3Workspace`: persistent GPT/Gemini workspace entries and local titles;
- `zero3GptWeb`: isolated ChatGPT Web `WebContentsView` lifecycle;
- `zero3GeminiWeb`: isolated Gemini Web `WebContentsView` lifecycle.

Codex is backend/runtime only. Codex stock UI/TUI is not a Zero3 product surface.

The pinned Hermes repository currently remains an Electron/Vite/packaging donor. Its React application is not reachable after `apply-zero3-owned-ui.mjs` replaces `src/main.tsx`. New product UI work belongs here, not in the Hermes renderer.

## Three-column contract

1. navigation rail;
2. unified Codex/GPT/Gemini session list;
3. main workspace, with an optional properties drawer inside the third column.

The Codex workspace is driven from authoritative `thread/list`, `thread/read`, `turn/start` and app-server events. Approval and request-user-input server requests are answered explicitly by the user and unsupported request classes fail closed.

GPT/Gemini workspaces use the real isolated `WebContentsView` providers. The React host rectangle is measured and continuously synchronized through the provider's typed `show`/`setBounds` calls.

No sample sessions, fake execution plans or fake tool results may be introduced into this renderer. Empty states must remain truthful when no runtime data exists.
