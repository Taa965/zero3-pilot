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

## Worker Runtime projection

The long-lived Web-GPT Worker Runtime is treated as a lease/session execution mirror, not as the business Workflow authority. `Zero3WorkflowWorkerProjectionService` publishes only Task-side `READY` / `FIX_REQUIRED` GPT StageRuns into the Worker Runtime. Each mirror StageRun carries `authoritativeStageRunId` and `authoritativeAttempt`. When the plugin commits structured Artifacts, the projection translates them back to the authoritative WorkItem/StageRun, verifies storage, and passes the Task Completion Gate before downstream work is released.

This also solves dynamic Artifact inputs. Downstream visual/image work is not pre-seeded with stale inputs: the Task Runtime first records and verifies the upstream Artifact, then creates a fresh Worker mirror unit whose inputs contain the actual Drive `fileId`. A failed verification increments the authoritative retry attempt and therefore creates a new mirror identity instead of pretending a completed plugin mirror can be reused. When a newly projected stage changes a Worker Runtime queue from empty to READY, the shared P5 wakeup controller can wake the bound idle GPT Web physical session; Task Center does not need to push a full per-item prompt for every script.


## Worker queue authority

`Zero3WorkflowWorkerQueueService` is the task-side bridge for Worker Protocol v2. It atomically claims the next per-item StageRun for a WorkerSlot, recovers an already-active claim after a transport retry, verifies producer scope and Artifact availability, passes the Completion Gate, and only then claims the next item for that logical workstation. This removes the unsafe `list READY -> claim later` race when multiple GPT workers share one stage queue.

The GPT plugin remains responsible for Binding Ticket / generation fencing and physical ChatGPT session lifecycle. Workflow Runtime remains authoritative for which WorkItem/StageRun is claimable and whether a reported Artifact is enough to release downstream work.

## Artifact transport

`Zero3ArtifactTransportRouter` provides environment-aware routing:

- web boundary -> Google Drive;
- local -> local -> local storage;
- local/remote boundary -> remote-compute transport.

Actual provider credentials remain outside Workflow definitions. `GoogleDriveArtifactProvider` remains an injected contract, while `GoogleDriveRestArtifactPort` now implements authenticated Drive v3 verify/download/folder creation/idempotent upload. The desktop runtime enables it only when credentials are supplied outside the renderer.

## Project-scoped GPT-GPU runner discovery

The selected Zero3 Project root is frozen into the cognitive-store run metadata. If no global `ZERO3_GPT_GPU_RUNNER_*` override is configured, Desktop resolves the existing project-local `config/gpt_gpu_runner_remote.json` plus `data/secrets/gpt-gpu-runner-token.txt`. The bearer token stays in the media project secret file; Pilot only opens it in Electron main when the cloud stage actually needs the runner. This lets an existing Zero3 media project reuse its already-provisioned `https://03.336r.com/api/handoff/v1/*` runner without duplicating credentials into Task Center.

## Task Center UI

The left pane lists Workflow Runs rather than fake Agent tasks. `+ 新建` opens the Workflow Module picker. Selecting a module mounts its registered CreateRun view. Selecting a run mounts the module's RunView inside the common shell.

The cognitive-store run view shows fixed GPT workstations plus a per-WorkItem pipeline matrix, so Script/Visual/Image stages can visibly overlap.

## Current boundary

V1 now implements the module registry, durable per-item runtime, Artifact registry/router, direct Google Drive REST adapter, automatic LOCAL→Drive input ingest, cognitive-store module definition, Electron IPC/preload bridge, and module-host Task Center UI. Web Worker wakeup/session rotation and concrete AIGate remote execution remain separate integration adapters; they are not faked by the Task Center.

### Google Drive direct configuration

Zero3 never exposes Drive tokens to the renderer. The desktop main process enables direct Drive when either `ZERO3_GOOGLE_DRIVE_ACCESS_TOKEN_FILE` points to an externally refreshed bearer token file, or the refresh-token triplet `ZERO3_GOOGLE_DRIVE_CLIENT_ID`, `ZERO3_GOOGLE_DRIVE_CLIENT_SECRET_FILE`, and `ZERO3_GOOGLE_DRIVE_REFRESH_TOKEN_FILE` is configured. Local scripts are then uploaded idempotently by Artifact id, relocated to a Drive locator, verified, and only then release that WorkItem's `script-rewrite` StageRun. Interactive OAuth account-connection UI is still a later product step.

## Durable remote render identity

`workflow_external_jobs` is the authoritative remote-job ledger for cloud stages. Zero3 persists a provider + request key intent before any submission. A returned remote execution id is immutable for that attempt and later polling reconciles that same id. A new request key is allowed only after a definite `FAILED` or `CANCELLED` outcome.

`Zero3WorkflowRemoteRenderService` requires an idempotent provider adapter and first tries `resolveByRequestKey`. If a submission response is ambiguous, the job becomes `OUTCOME_UNKNOWN` and the StageRun moves to `WAITING_HUMAN`; the runtime will not blindly submit another GPU job. The concrete AIGate/cloud adapter is intentionally still outside the generic Workflow Runtime.

## Local handoff materialization

The cognitive-store image worker must create a ZIP whose root contains `handoff.json` with `protocol` (or compatibility `schema`) equal to `zero3.gpt-gpu-handoff/1.0`. `Zero3LocalHandoffIngestService` verifies the Drive file, downloads it into the Workflow cache, reads `handoff.json` directly from the ZIP central directory without extracting arbitrary files, checks WorkflowRun/WorkItem identity when present, and registers a verified `local-handoff` Artifact. Only then does the `cloud-render` StageRun become READY.

The Task Center exposes a recovery action for pending/failed handoff materialization. Normal future Worker integration should call the same service from the artifact event path; Drive directory scanning remains a reconciliation/recovery mechanism rather than the authoritative scheduler.

## Deployed GPT → GPU runner integration

The generic `REMOTE_COMPUTE` boundary now has a concrete adapter for the existing production GPT→GPU runner instead of a hypothetical AIGate shim. `Zero3GptGpuRunnerPort` speaks the deployed API directly:

- `POST /api/handoff/v1/runs` uploads the raw reviewed ZIP.
- `GET /api/handoff/v1/runs/{run_id}` reconciles the same remote run.
- `GET /api/handoff/v1/runs/{run_id}/files/{job_id}` pulls each generated MP4.

The request identity is `gptgpu:<package-sha256>` and the expected remote `run_id` is the first 24 hex characters of that SHA256. The runtime persists this request intent before network submission, resolves it before any retry, and never creates a second job after an ambiguous outcome. The production handoff manifest uses `schema: "zero3.gpt-gpu-handoff/1.0"`, requires `package_id`, `project_id`, and 1–500 Wan jobs, and the cognitive-store image-worker prompt now emits that exact contract.

Desktop configuration stays outside Renderer state:

```text
ZERO3_GPT_GPU_RUNNER_BASE_URL=https://03.336r.com
ZERO3_GPT_GPU_RUNNER_TOKEN_FILE=<absolute secret file path>
ZERO3_FFPROBE_BIN=<optional absolute ffprobe path>
```

The remote token is read only in Electron main/runtime. HTTP redirects are refused so an Authorization header cannot be forwarded to an unexpected host.

## Automatic local/cloud tail

Once the GPT image Worker commits `交接包.zip`, the non-GPT tail is driven by `Zero3WorkflowAutomationController`:

```text
Drive handoff Artifact
  -> local materialize + schema/identity validation
  -> cloud-render idempotent submit/reconcile
  -> remote result-set Artifact
  -> download every manifest job MP4
  -> ffprobe technical QC per MP4
  -> local video Artifacts + 视频回传清单.json
  -> WorkItem / WorkflowRun completed
```

The controller processes only safe READY/RUNNING states automatically. A local/Drive/pullback failure is left in human recovery instead of being retried forever. An `OUTCOME_UNKNOWN` cloud submission may be polled automatically because reconciliation by the stable package hash cannot create a duplicate remote job. Task UI actions remain as explicit recovery controls.
