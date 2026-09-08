#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run as root (or via sudo).' >&2
  exit 1
fi

binary="${1:-}"
: "${binary:?usage: deploy-memory-authority.sh /path/to/zero3-memory-server}"
: "${ZERO3_MEMORY_DOMAIN:?set ZERO3_MEMORY_DOMAIN before deployment}"
: "${ZERO3_MEMORY_MIGRATION_DATABASE_URL:?set ZERO3_MEMORY_MIGRATION_DATABASE_URL for schema migrations}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file='/etc/zero3-memory/authority.env'
service_file='/etc/systemd/system/zero3-memory-authority.service'
nginx_available="/etc/nginx/sites-available/zero3-memory-authority.conf"
nginx_enabled="/etc/nginx/sites-enabled/zero3-memory-authority.conf"
runtime_root='/opt/zero3-memory-runtime'
release_dir="${runtime_root}/releases/$(date -u +%Y%m%dT%H%M%SZ)"
current_link="${runtime_root}/current"

if [[ ! -f "$binary" || ! -x "$binary" ]]; then
  echo "Memory server binary is missing or not executable: $binary" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "Refusing deployment: create $env_file from deployment/memory/authority.env.example first." >&2
  exit 1
fi
chmod 0600 "$env_file"

if ! id zero3memory >/dev/null 2>&1; then
  useradd --system --home /var/lib/zero3-memory --shell /usr/sbin/nologin zero3memory
fi

install -d -m 0755 -o root -g root "$release_dir/bin"
install -d -m 0750 -o zero3memory -g zero3memory /var/lib/zero3-memory /var/log/zero3-memory
install -m 0755 -o root -g root "$binary" "$release_dir/bin/zero3-memory-server"

# Migrations are applied in lexical order and must be forward-safe.
for migration in "$repo_root"/deployment/memory/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  psql "$ZERO3_MEMORY_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

ln -sfn "$release_dir" "$current_link"
install -m 0644 "$repo_root/deployment/memory/systemd/zero3-memory-authority.service" "$service_file"

sed "s/__ZERO3_MEMORY_DOMAIN__/${ZERO3_MEMORY_DOMAIN//\//\\/}/g" \
  "$repo_root/deployment/memory/nginx/zero3-memory-authority.conf.template" \
  > "$nginx_available"
ln -sfn "$nginx_available" "$nginx_enabled"

systemctl daemon-reload
systemctl enable zero3-memory-authority.service
systemctl restart zero3-memory-authority.service

for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8790/ready >/dev/null; then
    break
  fi
  sleep 0.5
done
curl --fail --silent --show-error http://127.0.0.1:8790/ready >/dev/null

# Validate the full nginx configuration before any reload. If this fails, the
# existing nginx process is left untouched.
nginx -t
systemctl reload nginx

printf '\nZero3 Memory Authority deployed on loopback and nginx configuration reloaded.\n'
printf 'Next: verify DNS/TLS for %s before using wss/https externally.\n' "$ZERO3_MEMORY_DOMAIN"
