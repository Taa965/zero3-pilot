# Generic self-host contract

## Goals

The self-host path must run on any ordinary Linux VM or bare-metal host with no AWS dependency. The supported reference implementations are systemd and Docker; both expose the same Zero3 Pilot application configuration and persistent data model.

## Canonical topology

```text
Internet / LAN
    |
HTTPS reverse proxy or managed TLS
    |
127.0.0.1:${ZERO3_WEB_PORT}
    |
zero3-web
    |
/var/lib/zero3-pilot/control-plane
```

`zero3-web` continues to bind loopback. Public exposure belongs to a reverse proxy/load balancer. Do not change the application into a public `0.0.0.0` listener just to simplify deployment.

## Canonical Linux layout

```text
/opt/zero3-pilot/
  releases/<version-or-sha>/bin/zero3-web
  current -> releases/<version-or-sha>
/etc/zero3-pilot/
  zero3-pilot.env
  secrets/
    host.token
    control.token
/var/lib/zero3-pilot/
  control-plane/
/var/log/zero3-pilot/
```

Defaults are intentionally boring and provider-neutral. A packaging implementation may expose alternative roots, but the application protocol must not contain these paths.

## Required deployment inputs

- release source: GitHub Release artifact, locally built binary, or container image;
- local listen port (`ZERO3_WEB_PORT`, generic default `8787`);
- public hostname only when HTTPS/public access is requested;
- H5 secret file paths when Remote Host control is enabled;
- persistent data directory.

No cloud access key is a Zero3 Pilot application input.

## systemd strategy

- dedicated non-login/service account by default;
- `EnvironmentFile=/etc/zero3-pilot/zero3-pilot.env`;
- immutable release directory + atomic `current` symlink;
- restart only the Zero3 Pilot unit;
- `NoNewPrivileges=true` and filesystem write access restricted to runtime data/log locations;
- secrets readable by the service account, mode `0600` or stricter equivalent;
- rollback by switching `current` back to the previous known-good release.

The current production helper is a valid implementation example, but generic packaging must not embed a specific hostname, SSH key, or unrelated-project assumption.

## Docker strategy

- one image contains only the compiled `zero3-web` runtime and required OS CA material;
- run as a non-root UID;
- bind container port only to loopback by default (`127.0.0.1:8787:8787`);
- mount a persistent volume at `/var/lib/zero3-pilot`;
- mount host/control token files read-only;
- do not bake token files, cloud credentials, GitHub credentials, or SSH keys into the image;
- healthcheck calls `/health` and requires `status == "ok"`;
- upgrade by immutable image tag/digest, then verify `/health` before deleting the previous image.

Docker packaging is not allowed to create a second scheduler/runtime. It is only another process/container wrapper around the same `zero3-web` binary.

## HTTPS

Supported patterns:

1. Caddy on the same host with automatic ACME;
2. nginx + Certbot;
3. provider-managed load balancer + certificate service;
4. private/LAN deployment with an operator-managed CA.

The deployment contract requires TLS for Internet-exposed control/pairing endpoints. HTTP is acceptable only on loopback or explicitly private trusted networks during setup.

## Health and readiness

`GET /health` is the stable deployment health surface. A successful upgrade requires:

- HTTP 200;
- JSON `status == "ok"`;
- build `git_sha` equals the intended release when the release source provides a Git SHA.

Pairing/Remote Host readiness must later use a separate authenticated status surface; do not overload `/health` with secret or credential state.

## Upgrade and rollback

1. stage immutable release/image;
2. preserve data and secrets;
3. switch to new release;
4. restart/recreate only Zero3 Pilot;
5. verify `/health` and expected build identity;
6. on failure, restore the previous release/image and restart;
7. never delete the previous known-good release before verification.

A future schema migration must be expand-compatible or provide a tested rollback blocker. This deployment layer must not guess whether H5 data is backward-compatible.