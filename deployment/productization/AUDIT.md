# Deployment assumption audit

Baseline: `main@9f11c6e8c88283dbcaf8cc51e6a6fb35c5f25f7f`.

The current deployment is a valid isolated production setup, but it encodes one operator's environment. This audit separates invariants worth preserving from values that must become installation inputs.

| Current assumption | Where observed | Classification | Productization action |
|---|---|---|---|
| AWS Lightsail host `34.218.104.186` | `deployment/README.md`, `docs/DEPLOYMENT.md` | environment-specific | remove from generic install contract; host/IP is operator input |
| public name `pilot.03.336r.com` | nginx + deployment docs | environment-specific | `PUBLIC_HOSTNAME` input; no protocol dependency |
| Linux identity `zero3pilot` | bootstrap/systemd/deploy | reasonable default | keep as default, allow installer/template override before install |
| `/opt/zero3-pilot-runtime`, `/etc/zero3-pilot`, `/var/lib/zero3-pilot` | bootstrap/systemd/deploy | portable Linux convention | keep canonical defaults; document as install contract |
| local port `8788` | systemd/deploy/workflow | environment-specific override | generic default follows application default `8787`; allow `ZERO3_WEB_PORT` override |
| repository-owned `deployment/ssh_known_hosts` | deploy workflow | target-specific trust material | current production only; generic CI must obtain/pin host key per installation, not from upstream source |
| fixed GitHub repo URL `Taa965/zero3-pilot.git` | bootstrap | upstream-specific | generic installer accepts source/image version; official template may default to upstream |
| fixed privileged helper name | bootstrap/deploy | implementation detail | preserve least-privilege restart boundary; make it installer-owned rather than protocol-visible |
| nginx + Certbot | nginx/docs | implementation choice | supported reference path, not required protocol; Caddy/managed LB are valid alternatives |
| GitHub Actions SSH deployment | workflow/docs | release-channel choice | keep current production; generic self-host supports release artifact/image pull without GitHub account coupling |
| shared-host isolation narrative | deployment docs | operator-specific | preserve principles (dedicated user, dirs, service, secrets), remove unrelated-project names from generic docs |
| `/health` returning `status` + exact build `git_sha` | server/deploy | product invariant | preserve for readiness and post-upgrade verification |
| H5 token files configured as a pair | `apps/web/src/control_plane.rs` | product invariant | expose only file paths in deployment config; never inline secret values in checked-in config |
| H5 durable data under local filesystem | control-plane | product invariant for current release | mount/persist `ZERO3_CONTROL_PLANE_DATA_DIR`; backup before destructive upgrade |

## Security findings

1. The current server has no AWS credential requirement. AWS is a hosting option, not a protocol dependency.
2. H5 fails closed when only one of the host/control token files is configured. Generic packaging must preserve that behavior.
3. The existing production bootstrap uses a dedicated account and a narrow restart-only sudo helper. Preserve this least-privilege shape for systemd installs.
4. A repository-pinned SSH host key is safe for the one current host but cannot ship as a generic trust root.
5. Pairing credentials must be per node; they must not reuse deploy keys, GitHub tokens, control-plane admin tokens, or cloud credentials.

## Migration stages

### P1A - this branch

Documentation/contracts only under `deployment/productization/**`. Existing production files remain untouched.

### P1B - after review

Add tested generic systemd installer and Docker packaging using the contracts here. No pairing backend dependency.

### P1C - after R4/H5 contract freeze

Implement pairing endpoints and node credential lifecycle in an integration-controller-approved backend path.

### P1D - after pairing is stable

Add AWS CloudFormation Quick Deploy and onboarding UI. AWS parameters terminate at the deployment template boundary.

## Stop conditions

Stop and request integration-controller arbitration if implementation requires changing H5 fencing/lease/outbox semantics, Executor private types, approval policy, credential authority, or another session's owned path.