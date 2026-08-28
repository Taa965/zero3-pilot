# Deployment

**Status: deferred by explicit decision, not blocked by a technical
problem.**

An existing AWS Lightsail host (`34.218.104.186`, us-west-2) already runs an
unrelated production system ("零三自媒体管理系统") with its own `zero3.service`
/ `zero3-cloud.service` systemd units, a fixed sudo whitelist
(`zero3-deploy-release`, `zero3-verify`, `zero3-host-maintenance`), and its
own GitHub Actions self-hosted runner. Zero3 Pilot is an unrelated product
that happens to share the "zero3" name. Rather than risk a naming or port
collision on that host, deployment was deliberately deferred during Phase 1
setup pending a decision on the target host — options discussed:

1. **Reuse the same Lightsail host**, isolated by subdomain
   (`pilot.<domain>`), its own upstream port (see
   `deployment/nginx/zero3-pilot.conf`), and a `zero3pilot-*` naming prefix
   for every systemd unit / sudo entry so nothing collides with the
   existing `zero3-*` names.
2. **Provision a separate host** for full isolation from the production
   自媒体 system.

## What's ready for whichever is chosen

- [`deployment/systemd/zero3-web.service`](../deployment/systemd/zero3-web.service) —
  idempotent unit template (create-if-missing / reload-if-present, matches
  §13 of the project brief).
- [`deployment/nginx/zero3-pilot.conf`](../deployment/nginx/zero3-pilot.conf) —
  standalone site block, does not touch any other `server{}` block.
- [`deployment/deploy.sh`](../deployment/deploy.sh) — atomic
  `releases/<sha>/` + `current` symlink swap, health-checks before
  switching, auto-rolls-back to the previous release on failure.
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) —
  `workflow_dispatch`-only for now (no `push` trigger) so it cannot fire
  accidentally; flip it to run on `push: main` once `DEPLOY_HOST`,
  `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` secrets are
  set via `gh secret set`.

## Before running this for real, in order

1. Pick a target host (see options above) and confirm with the user.
2. `ssh` in and run the read-only audit from the project brief
   (`uname -a`, `nginx -v`, `systemctl status nginx`, `ss -lntp`,
   `systemctl list-units --type=service`) — reuse what's there, don't
   reinstall.
3. Pick a subdomain, confirm DNS already resolves to the target host before
   running certbot (do not loop certbot waiting for DNS).
4. Pin the SSH host key into a `known_hosts` GitHub Actions can trust — no
   `StrictHostKeyChecking=no` as a permanent setting.
5. Set the five `DEPLOY_*` secrets with `gh secret set`, sourced from the
   real SSH command that already works (do not guess a username).
6. Flip `deploy.yml`'s trigger on, push, verify `/health` externally,
   re-run a second time to prove idempotency, then verify rollback by
   deliberately deploying a broken build once.
