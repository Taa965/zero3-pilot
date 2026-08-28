# deployment/

**Status: not wired up yet.** This project has an existing production AWS
Lightsail host already running an unrelated system ("Zero3 自媒体管理系统").
Rather than guess a target and risk colliding with it, server deployment for
Zero3 Pilot is deliberately deferred until a dedicated host is chosen — see
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

The templates in this directory are reference-only: idempotent by
construction (safe to apply repeatedly), but not yet pointed at a real host
or exercised by CI. `.github/workflows/deploy.yml` is `workflow_dispatch`
only (no push trigger) until `DEPLOY_HOST` etc. are configured as repo
secrets.

- `systemd/zero3-web.service` — service unit template.
- `nginx/zero3-pilot.conf` — reverse-proxy site template (own subdomain, own
  upstream port — must not reuse a port already bound on the target host).
- `deploy.sh` — release script skeleton: `releases/<sha>/` + atomic `current`
  symlink swap + health check before switching, so a bad release never
  replaces a good one.
