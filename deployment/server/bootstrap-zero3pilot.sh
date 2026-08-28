#!/usr/bin/env bash
# Idempotent, isolated provisioning for Zero3 Pilot on a shared host that
# already runs an unrelated Zero3 self-media system. Run as an admin user
# with sudo (e.g. `sudo bash bootstrap-zero3pilot.sh <ssh-pubkey>`).
#
# Safe to run repeatedly. Never touches: zero3.service, zero3-cloud*,
# zero3-assets.service, zero3-bridge.service, zero3-github-runner.service,
# zero3-runtime-v3-worker.service, /opt/zero3, /etc/zero3, or any
# zero3/zero3bridge/zero3-runner Linux account/group. Everything this
# script creates is prefixed `zero3-pilot` / `zero3pilot`.
set -euo pipefail

PUBKEY="${1:?usage: bootstrap-zero3pilot.sh '<ssh-ed25519 AAAA... comment>'}"
REPO_URL="https://github.com/Taa965/zero3-pilot.git"

CHECKOUT=/opt/zero3-pilot
RUNTIME=/opt/zero3-pilot-runtime
CONFIG=/etc/zero3-pilot
DATA=/var/lib/zero3-pilot
LOGS=/var/log/zero3-pilot

echo "[1/8] user/group zero3pilot"
if ! getent group zero3pilot >/dev/null; then
    groupadd --system zero3pilot
fi
if ! id -u zero3pilot >/dev/null 2>&1; then
    useradd --system --gid zero3pilot --home-dir /home/zero3pilot \
        --create-home --shell /usr/sbin/nologin zero3pilot
fi

echo "[2/8] directories"
mkdir -p "$CHECKOUT" "$RUNTIME/releases" "$CONFIG" "$DATA" "$LOGS"
chown -R zero3pilot:zero3pilot "$CHECKOUT" "$RUNTIME" "$DATA" "$LOGS"
chown root:zero3pilot "$CONFIG"
chmod 750 "$CONFIG"

echo "[3/8] SSH access (dedicated deploy key, not the shared admin key)"
install -d -m 700 -o zero3pilot -g zero3pilot /home/zero3pilot/.ssh
AUTH=/home/zero3pilot/.ssh/authorized_keys
touch "$AUTH"
if ! grep -qF "$PUBKEY" "$AUTH"; then
    echo "$PUBKEY" >> "$AUTH"
fi
chown zero3pilot:zero3pilot "$AUTH"
chmod 600 "$AUTH"

echo "[4/8] fixed, narrow sudo entry (daemon-reload + restart this service only)"
install -m 755 -o root -g root /dev/stdin /usr/local/sbin/zero3pilot-deploy-release <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl daemon-reload
systemctl restart zero3-pilot.service
EOF

SUDOERS_TMP="$(mktemp)"
echo 'zero3pilot ALL=(root) NOPASSWD: /usr/local/sbin/zero3pilot-deploy-release' > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP"
install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/zero3pilot
rm -f "$SUDOERS_TMP"

echo "[5/8] git checkout at $CHECKOUT (public repo, no credentials needed)"
if [ -d "$CHECKOUT/.git" ]; then
    sudo -u zero3pilot git -C "$CHECKOUT" fetch origin main
    sudo -u zero3pilot git -C "$CHECKOUT" reset --hard origin/main
else
    sudo -u zero3pilot git clone --branch main "$REPO_URL" "$CHECKOUT"
fi

echo "[6/8] systemd unit (create if missing, reload if present)"
NEW_UNIT=false
if [ ! -f /etc/systemd/system/zero3-pilot.service ]; then
    NEW_UNIT=true
fi
install -m 644 -o root -g root \
    "$CHECKOUT/deployment/systemd/zero3-pilot.service" \
    /etc/systemd/system/zero3-pilot.service
systemctl daemon-reload
if [ "$NEW_UNIT" = true ]; then
    systemctl enable zero3-pilot.service
fi

echo "[7/8] nginx site (independent site, test before reload, never restart)"
install -m 644 -o root -g root \
    "$CHECKOUT/deployment/nginx/zero3-pilot.conf" \
    /etc/nginx/sites-available/zero3-pilot
ln -sfn /etc/nginx/sites-available/zero3-pilot /etc/nginx/sites-enabled/zero3-pilot
if nginx -t; then
    systemctl reload nginx
else
    echo "nginx -t FAILED — leaving nginx running on its previous config" >&2
    rm -f /etc/nginx/sites-enabled/zero3-pilot
    exit 1
fi

echo "[8/8] done"
echo "ZERO3PILOT_BOOTSTRAP=PASS"
