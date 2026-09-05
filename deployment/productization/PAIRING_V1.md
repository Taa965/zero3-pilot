# Pairing v1 protocol proposal

Status: Wave 0 contract proposal. Backend implementation waits for the integration controller to freeze the relevant H5/R4 boundary.

Protocol name: `zero3.pilot.pairing.v1`.

## Goals

- let a fresh Remote Host node enroll without copying the H5 admin/control token to that node;
- use a short-lived, one-time pairing code for human-mediated bootstrap;
- issue a unique per-node credential after successful claim;
- support credential rotation and explicit revocation;
- keep cloud, deploy, GitHub and executor credentials outside the pairing protocol;
- never silently create a new identity after a failed resume/credential check.

## Authorities

- **Pairing issuer**: authenticated Zero3 Pilot control/admin surface. It creates one-time codes.
- **Pairing claimant**: an unpaired node that knows the one-time code.
- **Node credential**: server-issued opaque secret scoped to exactly one `node_id` and Remote Host node operations.
- **Control credential**: remains separate and must never be returned by pairing.

Pairing does not grant Agent/Executor authority. It grants only node authentication to the existing Remote Host/H5 surface.

## One-time code requirements

- generated from cryptographically secure randomness;
- human-display form may be shortened/encoded, but server-side entropy must be at least 128 bits before presentation encoding or use an equivalent high-entropy verifier design;
- default lifetime: 5 minutes;
- one successful claim consumes the code atomically;
- failed attempts are rate-limited and bounded;
- server stores a verifier/hash, not the reusable plaintext code;
- code is never accepted after expiry, consumption, revocation, or issuer cancellation.

## Claim endpoint

`POST /api/pair/v1/claim`

Request view:

```json
{
  "protocol": "zero3.pilot.pairing.v1",
  "pairing_code": "human-entered-one-time-code",
  "node": {
    "requested_node_id": "optional-client-stable-id",
    "display_name": "Office PC",
    "platform": "windows",
    "client_version": "0.9.0"
  }
}
```

Successful response view:

```json
{
  "protocol": "zero3.pilot.pairing.v1",
  "node_id": "server-authoritative-node-id",
  "credential": "opaque-secret-returned-once",
  "credential_id": "non-secret-id",
  "issued_at": "RFC3339",
  "server": {
    "base_url": "https://pilot.example.com",
    "credential_version": 1
  }
}
```

The plaintext node credential is returned exactly once. Server persistence stores only a strong verifier/hash plus metadata required for rotation/revocation/audit.

## Claim invariants

The claim transaction must atomically:

1. validate code exists, is unexpired, unconsumed and not rate-limited;
2. reserve or create the authoritative `node_id`;
3. create the node credential record;
4. consume the code;
5. persist an audit event;
6. return the plaintext node credential once.

A crash must not yield both a usable credential and a reusable pairing code. Retry after an ambiguous response must use an explicit claim-recovery/idempotency design; it must not mint a second node silently.

## Authentication after pairing

The per-node credential authenticates only node-scoped Remote Host operations. The backend adapter may map it to current H5 authorization internally, but the long-term H5 host token must not be copied to every node as the productized credential model.

The exact H5 adapter seam is an integration-controller decision after R4/H5 freeze.

## Rotation

Proposed authenticated endpoint:

`POST /api/pair/v1/nodes/{node_id}/credentials/rotate`

Requirements:

- current valid node credential or stronger control/admin authority required;
- new secret returned once;
- old credential receives a short bounded overlap only when explicitly requested by policy; default is immediate invalidation after successful rotation commit;
- rotation increments `credential_version` and emits an audit event;
- replay of an old rotation request is idempotent or rejected deterministically.

## Revoke

Proposed control/admin endpoint:

`POST /api/pair/v1/nodes/{node_id}/revoke`

Revocation invalidates all active credentials for the node and prevents new leases until the node is explicitly paired/approved again. Revocation must not delete historical task/event evidence.

## Windows storage

The Windows client stores only:

- server base URL;
- `node_id`;
- non-secret credential metadata;
- node credential in Windows Credential Manager / DPAPI-backed secure storage.

Never store the node credential in repository files, plain JSON settings, SQLite rows without OS protection, logs, crash dumps, clipboard history, or telemetry.

## Error model

Pairing errors are typed at the protocol boundary:

- `invalid_code`;
- `expired_code`;
- `consumed_code`;
- `rate_limited`;
- `node_conflict`;
- `credential_revoked`;
- `server_policy_denied`;
- `storage_failure`.

Errors must not leak whether unrelated node IDs or credentials exist beyond what the claimant is authorized to know.

## Security tests required for implementation

- expired/consumed code rejection;
- concurrent double-claim: exactly one winner;
- brute-force/rate-limit fixture;
- crash between credential creation and code consumption;
- credential hash/verifier only at rest;
- rotation invalidates old credential as configured;
- revoke blocks lease/heartbeat authorization without deleting evidence;
- no H5 control token, deploy key, GitHub token, AWS key or executor credential appears in pair responses/logs;
- Windows persistence never falls back to plaintext when secure storage fails.
