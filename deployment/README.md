# deployment/

Zero3 Pilot's control/web server is deployed to the same AWS Lightsail host
(`34.218.104.186`) as the existing, unrelated "Zero3 自媒体管理系统" — both
projects are in active development and the host is shared by decision, not
by accident. Isolation is enforced by construction, not by convention:

| | Zero3 Pilot | Existing Zero3 self-media system |
|---|---|---|
| Linux user | `zero3pilot` | `zero3`, `zero3bridge`, `zero3-runner`, ... |
| Checkout | `/opt/zero3-pilot` | `/opt/zero3` |
| Runtime | `/opt/zero3-pilot-runtime` | `/opt/zero3-*-runtime` |
| Config | `/etc/zero3-pilot` | `/etc/zero3`, `/etc/zero3-bridge` |
| Data | `/var/lib/zero3-pilot` | (its own) |
| systemd | `zero3-pilot.service` | `zero3.service`, `zero3-cloud.service`, ... |
| Port | `127.0.0.1:8788` | `8770` (uvicorn), others |
| Nginx site | `zero3-pilot` (own `server{}` block) | `zero3`, `zero3-03-336r-com` |
| sudo | one fixed entry: `zero3pilot-deploy-release` (daemon-reload + restart *only its own unit*) | its own, untouched |
| GitHub Actions runner | none — GitHub-hosted `ubuntu-latest` | self-hosted, registered to `Taa965/zero3-commander-bridge` only |

Zero3 Pilot's deploy identity cannot read or modify anything belonging to
the other project: no shared sudo entries, no shared directories, no
shared systemd units, no shared Linux group beyond default `users`-level
read access, no access to its database, `.env`, deploy key, or Commander
token.

## Files

- [`server/bootstrap-zero3pilot.sh`](server/bootstrap-zero3pilot.sh) —
  one-time (idempotent, safe to re-run) provisioning: creates the
  `zero3pilot` user, directories, the one sudoers entry, the systemd unit,
  and the Nginx site. Run as an admin user with sudo; never touches any
  `zero3`/`zero3bridge`/`zero3-runner` resource.
- [`systemd/zero3-pilot.service`](systemd/zero3-pilot.service) — the unit
  the bootstrap script installs.
- [`nginx/zero3-pilot.conf`](nginx/zero3-pilot.conf) — independent site
  block for `pilot.03.336r.com`; HTTP only until DNS for that subdomain is
  created (see `docs/DEPLOYMENT.md` — deliberately not looping Certbot on
  missing DNS).
- [`deploy.sh`](deploy.sh) — run by GitHub Actions (as `zero3pilot`, over
  SSH) on every push to `main`: atomic `releases/<sha>/` + `current`
  symlink swap, health-checks on `127.0.0.1:8788/health`, auto-rolls back
  to the previous release on failure.
- [`ssh_known_hosts`](ssh_known_hosts) — the target host's public SSH host
  key (not a secret), pinned so CI never uses
  `StrictHostKeyChecking=no`.
