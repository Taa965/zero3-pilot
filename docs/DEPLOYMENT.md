# Deployment

## Target

Shared AWS Lightsail host `34.218.104.186` (also runs an unrelated,
independently-developed "Zero3 自媒体管理系统"). Both projects are in active
development; the host is shared by an explicit decision, isolated by
construction — see the isolation table in
[`deployment/README.md`](../deployment/README.md).

## How a deploy happens

```
push to main
  -> CI (fmt, clippy, build, test)
  -> build job: cargo build --release -p zero3-web (GitHub-hosted runner)
  -> deploy job:
       scp binary + deployment/deploy.sh to the host, as `zero3pilot`
       ssh: deployment/deploy.sh
         - releases/<sha>/bin/zero3-web
         - current -> releases/<sha> (atomic symlink swap)
         - sudo zero3pilot-deploy-release   (only privileged step: daemon-reload + restart)
         - curl 127.0.0.1:8788/health, retry up to 10x
         - on failure: symlink back to the previous release, restart again, exit 1
  -> external health check step re-confirms 200 over SSH
```

No GitHub-hosted step, and no code running under the `zero3pilot` account,
ever has: the existing Zero3 system's sudo entries, its `.env`, its
database credentials, its GitHub deploy key, or its Commander token. The
only sudo `zero3pilot` can run is
`/usr/local/sbin/zero3pilot-deploy-release`, which does exactly two things
(`systemctl daemon-reload`, `systemctl restart zero3-pilot.service`) and
nothing else.

The existing self-hosted GitHub Actions runner on this host is registered
to `Taa965/zero3-commander-bridge` only — it does not pick up
`zero3-pilot` workflow runs, and this project does not register a runner
on it either. All zero3-pilot CI/CD runs on GitHub-hosted `ubuntu-latest`.

## GitHub secrets (repository-level, set via `gh secret set`)

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `34.218.104.186` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_USER` | `zero3pilot` |
| `DEPLOY_SSH_KEY` | private half of a dedicated ed25519 keypair generated only for this purpose; the matching public key is the only line added to `zero3pilot`'s `authorized_keys` |
| `DEPLOY_PATH` | `/opt/zero3-pilot-runtime` |

## HTTPS / public domain

`03.336r.com` already resolves to this host with a working Let's Encrypt
certificate (used by the existing, unrelated site). No subdomain for Zero3
Pilot (`pilot.03.336r.com`) exists in DNS yet. Per the no-loop-certbot
rule: the Nginx site for `pilot.03.336r.com` is installed and passes
`nginx -t` (HTTP only, port 80), but Certbot has **not** been run and
external HTTPS is **not** live — this is intentionally listed under
Remaining below rather than blocking the rest of the pipeline.

## Status

First automated deploy (exact-SHA, atomic, health-checked) verified
2026-08-28. Isolation confirmed: the existing five Zero3 self-media
systemd units stayed active throughout, and its public health endpoint
kept returning 200 before, during, and after.

## Remaining (real gaps, not deferred-by-choice)

- DNS record for `pilot.03.336r.com` -> `34.218.104.186` (not something
  this environment can create — needs whoever controls `336r.com`'s DNS).
- `certbot --nginx -d pilot.03.336r.com` once that DNS record exists.
- Everything past the control/web server (computer use, browser
  automation, scheduler, memory) — Phase 1 scope, tracked in
  `docs/ARCHITECTURE.md`.
