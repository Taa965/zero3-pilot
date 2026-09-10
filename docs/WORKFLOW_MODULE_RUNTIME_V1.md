# Zero3 Workflow Module Runtime V1

## Purpose

The Task Center is no longer a hard-coded review board. It is a host for versioned, code-defined Workflow Modules. A module owns business-specific pipeline rules and UI, while Zero3 owns durable run state, WorkItem/StageRun scheduling, Artifact lineage, executor integration, and recovery.

```text
Task Center
  -> Workflow Registry
  -> Workflow Module
  -> Workflow Run
  -> WorkItem
  -> StageRun
  -> Worker / Executor
  -> Artifact
```

## Why WorkItem-level stages exist

A batch must pipeline instead of waiting for a whole macro Step to finish. If Item 01 finishes script rewriting, only `Item01/visual-plan` becomes READY while the script worker may immediately continue with Item 02. This makes a 20-script run behave like a production line rather than seven batch barriers.

## Runtime authority

`Zero3WorkflowStore` uses SQLite with WAL, FULL synchronous writes, foreign keys, and transactional updates. A run freezes the module id/version, stage definitions, worker definitions, prompt revisions, and module metadata at creation time. Updating a module later does not mutate an existing run.

Artifacts are registered by logical identity and storage locator. Google Drive is treated as a storage/transport provider, never as task authority. A Drive file is not considered stage completion until Zero3 registers and verifies the Artifact and the Completion Gate passes.

## First module: cognitive-store-video

The first production module defines:

1. input ingest / Drive upload;
2. GPT Web script rewrite worker;
3. GPT Web visual planning worker;
4. GPT Web image production worker;
5. Zero3 local handoff ingest;
6. remote/AIGate render;
7. local pullback and technical QC.

The image rule (overview first, then per chapter with at most 10 images per batch) lives only in this module. It is intentionally absent from the generic Workflow Runtime.

## Web workers

The module declares logical WorkerDefinitions (`script-worker`, `visual-worker`, `image-worker`). `worker-v2-adapter.ts` projects those definitions and item-level READY/FIX_REQUIRED StageRuns into the shared Worker Protocol v2 `WorkflowWorkerBinding` and `WorkflowWorkUnit` contracts. The parallel GPT Worker Protocol v2 effort owns physical ChatGPT session binding, Claim/Lease, wakeup, and session rotation; the Task runtime remains authoritative for WorkflowRun/WorkItem/StageRun dependencies.

## Artifact transport

`Zero3ArtifactTransportRouter` provides environment-aware routing:

- web boundary -> Google Drive;
- local -> local -> local storage;
- local/remote boundary -> remote-compute transport.

Actual provider credentials remain outside Workflow definitions. `GoogleDriveArtifactProvider` remains an injected contract, while `GoogleDriveRestArtifactPort` now implements authenticated Drive v3 verify/download/folder creation/idempotent upload. The desktop runtime enables it only when credentials are supplied outside the renderer.

## Task Center UI

The left pane lists Workflow Runs rather than fake Agent tasks. `+ 新建` opens the Workflow Module picker. Selecting a module mounts its registered CreateRun view. Selecting a run mounts the module's RunView inside the common shell.

The cognitive-store run view shows fixed GPT workstations plus a per-WorkItem pipeline matrix, so Script/Visual/Image stages can visibly overlap.

## Current boundary

V1 now implements the module registry, durable per-item runtime, Artifact registry/router, direct Google Drive REST adapter, automatic LOCAL→Drive input ingest, cognitive-store module definition, Electron IPC/preload bridge, and module-host Task Center UI. Web Worker wakeup/session rotation and concrete AIGate remote execution remain separate integration adapters; they are not faked by the Task Center.

### Google Drive direct configuration

Zero3 never exposes Drive tokens to the renderer. The desktop main process enables direct Drive when either `ZERO3_GOOGLE_DRIVE_ACCESS_TOKEN_FILE` points to an externally refreshed bearer token file, or the refresh-token triplet `ZERO3_GOOGLE_DRIVE_CLIENT_ID`, `ZERO3_GOOGLE_DRIVE_CLIENT_SECRET_FILE`, and `ZERO3_GOOGLE_DRIVE_REFRESH_TOKEN_FILE` is configured. Local scripts are then uploaded idempotently by Artifact id, relocated to a Drive locator, verified, and only then release that WorkItem's `script-rewrite` StageRun. Interactive OAuth account-connection UI is still a later product step.
