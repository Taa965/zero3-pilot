#!/usr/bin/env bash
# One-time, idempotent provisioning for Zero3 Memory Authority on a shared host.
# Run as an admin user with sudo:
#   sudo bash bootstrap-zero3memory.sh '<ssh-ed25519 AAAA... comment>' memory.example.com
#
# This script deliberately uses an independent account, checkout, runtime,
# config, data, log, systemd unit and nginx site. It never modifies the
# existing Zero3 self-media or Zero3 Pilot service identities/directories.
set -euo pipefail

PUBKEY="${1:?usage: bootstrap-zero3memory.sh '<ssh-ed25519 ...>' <memory-domain>}"
DOMAIN="${2:?usage: bootstrap-zero3memory.sh '<ssh-ed25519 ...>' <memory-domain>}"
REPO_URL='https://github.com/Taa965/zero3-pilot.git'
CHECKOUT='/opt/zero3-memory-source'
RUNTIME='/opt/zero3-memory-runtime'
CONFIG='/etc/zero3-memory'
DATA='/var/lib/zero3-memory'
LOGS='/var/log/zero3-memory'
SITE='/etc/nginx/sites-available/zero3-memory-authority'
SITE_LINK='/etc/nginx/sites-enabled/zero3-memory-authority'

if [[ "$EUID" -ne 0 ]]; then
  echo 'Bootstrap must run as root (for example through sudo).' >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo 'Memory domain contains unsupported characters.' >&2
  exit 1
fi

for required in git nginx visudo systemctl; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done

echo '[1/9] dedicated zero3memory user/group'
if ! getent group zero3memory >/dev/null; then groupadd --system zero3memory; fi
if ! id -u zero3memory >/dev/null 2>&1; then
  useradd --system --gid zero3memory --home-dir /home/zero3memory --create-home --shell /bin/bash zero3memory
else
  usermod --shell /bin/bash zero3memory
fi

echo '[2/9] isolated directories'
mkdir -p "$CHECKOUT" "$RUNTIME/releases" "$CONFIG" "$DATA" "$LOGS"
chown -R zero3memory:zero3memory "$CHECKOUT" "$RUNTIME" "$DATA" "$LOGS"
chown root:zero3memory "$CONFIG"
chmod 0750 "$CONFIG"

echo '[3/9] dedicated SSH deploy key'
install -d -m 0700 -o zero3memory -g zero3memory /home/zero3memory/.ssh
AUTH='/home/zero3memory/.ssh/authorized_keys'
touch "$AUTH"
if ! grep -qF "$PUBKEY" "$AUTH"; then echo "$PUBKEY" >> "$AUTH"; fi
chown zero3memory:zero3memory "$AUTH"
chmod 0600 "$AUTH"

echo '[4/9] narrow deploy helper and sudo rule'
install -m 0755 -o root -g root /dev/stdin /usr/local/sbin/zero3memory-deploy-release <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl daemon-reload
systemctl restart zero3-memory-authority.service
EOF
SUDOERS_TMP="$(mktemp)"
echo 'zero3memory ALL=(root) NOPASSWD: /usr/local/sbin/zero3memory-deploy-release' > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP"
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/zero3memory
rm -f "$SUDOERS_TMP"

echo '[5/9] source checkout'
if [[ -d "$CHECKOUT/.git" ]]; then
  sudo -u zero3memory git -C "$CHECKOUT" fetch origin main
  sudo -u zero3memory git -C "$CHECKOUT" reset --hard origin/main
else
  sudo -u zero3memory git clone --branch main "$REPO_URL" "$CHECKOUT"
fi

echo '[6/9] systemd unit'
install -m 0644 -o root -g root \
  "$CHECKOUT/deployment/memory/systemd/zero3-memory-authority.service" \
  /etc/systemd/system/zero3-memory-authority.service
systemctl daemon-reload
systemctl enable zero3-memory-authority.service

echo '[7/9] nginx site (validate before reload)'
sed "s/__ZERO3_MEMORY_DOMAIN__/${DOMAIN//\//\\/}/g" \
  "$CHECKOUT/deployment/memory/nginx/zero3-memory-authority.conf.template" > "$SITE"
ln -sfn "$SITE" "$SITE_LINK"
if nginx -t; then
  systemctl reload nginx
else
  echo 'nginx -t FAILED — keeping the running nginx process untouched.' >&2
  rm -f "$SITE_LINK"
  exit 1
fi

echo '[8/9] environment boundary'
if [[ ! -f "$CONFIG/authority.env" ]]; then
  install -m 0600 -o root -g zero3memory \
    "$CHECKOUT/deployment/memory/authority.env.example" \
    "$CONFIG/authority.env.example"
  echo "Create $CONFIG/authority.env from the example with real credentials before first service start."
else
  chown root:zero3memory "$CONFIG/authority.env"
  chmod 0640 "$CONFIG/authority.env"
fi

echo '[9/9] done'
echo 'ZERO3_MEMORY_BOOTSTRAP=PASS'
echo "Memory Authority remains loopback-only on 127.0.0.1:8790 behind nginx for $DOMAIN."
if [[ -f "$CONFIG/authority.env" ]]; then
  echo 'Environment exists; deploy a tested binary with deployment/memory/deploy-memory-authority.sh.'
else
  echo 'Service was enabled but intentionally not started because authority.env is absent.'
fi
