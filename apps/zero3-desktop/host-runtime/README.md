# Zero3 Desktop Host Runtime source templates

These TypeScript modules are Zero3-owned source templates for the local Remote Host Runtime.

They are copied into the pinned Hermes Electron main-process tree by `scripts/apply-remote-host-runtime.mjs` during `npm run prepare`.

They must remain a thin transport/correlation layer over `Zero3CodexAppServer`. Do not add a second model loop, direct remote shell, or Hermes runtime dependency here.
