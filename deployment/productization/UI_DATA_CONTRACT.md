# Hermes UI data contract (provider-neutral)

Status: Wave 0 view-model proposal. These are UI-facing DTOs, not R4 runtime private types. Runtime binding waits for the Executor/Handoff contracts to freeze.

## Principles

- the UI consumes stable product concepts, not ACP/Codex/Claude SDK structs;
- provider-specific details live in optional display metadata;
- availability/auth/quota are separate states; one must not be inferred from another;
- approval and policy state are never represented as a generic provider failure;
- Handoff timeline is evidence-based and ordered; model prose is not authoritative state.

## Settings -> Executors

```ts
type ExecutorSettingsItem = {
  executorId: string;
  displayName: string;
  kind: "native_codex" | "external_acp" | "api_provider" | "other";
  providerLabel?: string;
  enabled: boolean;
  availability: "unknown" | "available" | "degraded" | "unavailable";
  authState: "not_required" | "unknown" | "ready" | "needs_login" | "expired" | "error";
  quotaState: "unknown" | "ok" | "limited" | "exhausted";
  isPrimary?: boolean;
  capabilities: string[];
  lastCheckedAt?: string;
  message?: string;
};
```

UI actions are product intents only:

- enable/disable executor;
- set preferred/primary executor when policy allows;
- start provider-specific login through an adapter-owned action;
- refresh availability;
- view diagnostic details.

The UI must not expose a raw generic RPC console.

## Settings -> Remote Control

```ts
type RemoteControlSettings = {
  publicBaseUrl?: string;
  connectivity: "unknown" | "offline" | "connecting" | "online" | "error";
  tlsState: "unknown" | "not_configured" | "valid" | "invalid";
  pairingEnabled: boolean;
  pairedNodes: PairedNodeSummary[];
};

type PairedNodeSummary = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  state: "paired" | "online" | "offline" | "revoked";
  credentialVersion?: number;
  lastSeenAt?: string;
  activeTaskId?: string;
  pendingDeliveries?: number;
};
```

Allowed UI actions:

- create/show a one-time pairing code (only through authenticated backend authority);
- revoke node;
- rotate this node's credential where policy permits;
- copy public server URL;
- show TLS/connectivity diagnostics.

Never display the current plaintext node credential after the one-time enrollment response.

## Pairing presentation state

```ts
type PairingSessionView = {
  pairingId: string;
  displayCode: string;
  expiresAt: string;
  state: "active" | "claimed" | "expired" | "cancelled";
};
```

The UI treats the display code as ephemeral sensitive material: no analytics, no persistent local history, no automatic log capture.

## Task -> Executor/Handoff Timeline

```ts
type ExecutionTimelineItem = {
  eventId: string;
  taskId: string;
  executionId: string;
  generation?: number;
  occurredAt: string;
  type:
    | "executor_selected"
    | "executor_failed"
    | "handoff_created"
    | "executor_switched"
    | "handoff_verified"
    | "executor_completed";
  executorId?: string;
  fromExecutorId?: string;
  toExecutorId?: string;
  handoffId?: string;
  status?: "pending" | "verified" | "failed" | "completed";
  reasonCode?: string;
  summary?: string;
  evidenceRefs?: string[];
};
```

Ordering uses backend-authoritative sequence/time semantics once R4I defines the event envelope. The UI must not invent ordering from arrival time when replay/outbox delivery is involved.

## Wireframe

```text
Settings
  Executors
    [Primary] Native Codex        Ready      Quota OK
              Claude (ACP)       Offline    Auth Ready
              API Provider       Disabled

  Remote Control
    Server: https://pilot.example.com   TLS Valid   Online
    [Pair new computer]

    Office PC     Online   last seen 12s ago   [Rotate] [Revoke]
    Laptop        Offline  last seen 2h ago    [Revoke]

Task detail
  Executor / Handoff
    10:01 Native Codex selected
    10:17 Native Codex failed: quota_exhausted
    10:17 Handoff created
    10:18 Handoff verified
    10:18 Claude selected
    10:33 Claude completed
```

## Boundary with future R4 contracts

A later adapter maps frozen Executor/Handoff runtime events into these view models. If the frozen contract cannot represent a required field, Session 8 must submit an `INTERFACE CHANGE REQUEST`; it must not import or mutate another session's private runtime type directly.

## UI acceptance gates

- no provider-specific SDK type crosses into React components;
- no raw auth token/credential is rendered after initial one-time claim;
- quota exhaustion is distinguishable from permission/policy denial;
- revoked/offline/unavailable are distinct node states;
- timeline survives replay without duplicate visible events;
- timeline can identify executor generation/handoff when the frozen backend exposes them;
- no UI action bypasses approval, Handoff Gate, lease, fencing, or backend authorization.
