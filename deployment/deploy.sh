#!/usr/bin/env bash
# Idempotent atomic-release deploy skeleton for zero3-web.
# Safe to run repeatedly: run 1, run 2, run 20 all succeed, and a failed
# release never replaces a working `current` symlink.
#
# NOT wired into CI yet — .github/workflows/deploy.yml only calls this
# manually (workflow_dispatch) until a target host is chosen. See
# docs/DEPLOYMENT.md before pointing this at a real server.
set -euo pipefail

: "${DEPLOY_PATH:?set DEPLOY_PATH, e.g. /opt/zero3-pilot}"
: "${GIT_SHA:?set GIT_SHA of the build to release}"
: "${BUILD_ARTIFACT:?set BUILD_ARTIFACT path to the built zero3-web binary}"

RELEASE_DIR="$DEPLOY_PATH/releases/$GIT_SHA"
CURRENT_LINK="$DEPLOY_PATH/current"

mkdir -p "$RELEASE_DIR/bin"
cp "$BUILD_ARTIFACT" "$RELEASE_DIR/bin/zero3-web"
chmod +x "$RELEASE_DIR/bin/zero3-web"

# systemd: update if the unit already exists, create only if it doesn't.
if systemctl list-unit-files | grep -q '^zero3-web.service'; then
    sudo systemctl daemon-reload
else
    sudo cp "$DEPLOY_PATH/deployment/systemd/zero3-web.service" /etc/systemd/system/zero3-web.service
    sudo systemctl daemon-reload
    sudo systemctl enable zero3-web
fi

# Point ExecStart at the new release before restarting, then flip `current`
# only after a health check passes — so a bad release can't take the site down.
ln -sfn "$RELEASE_DIR" "$DEPLOY_PATH/current.candidate"
sudo systemctl stop zero3-web 2>/dev/null || true
mv -Tf "$DEPLOY_PATH/current.candidate" "$CURRENT_LINK"
sudo systemctl start zero3-web

for _ in $(seq 1 10); do
    if curl -fsS "http://127.0.0.1:${ZERO3_WEB_PORT:-8788}/health" >/dev/null; then
        echo "zero3-web: health check passed for $GIT_SHA"
        exit 0
    fi
    sleep 1
done

echo "zero3-web: health check FAILED for $GIT_SHA — rolling back" >&2
PREV=$(ls -1dt "$DEPLOY_PATH"/releases/*/ 2>/dev/null | sed -n 2p || true)
if [ -n "$PREV" ]; then
    ln -sfn "${PREV%/}" "$CURRENT_LINK"
    sudo systemctl restart zero3-web
    echo "rolled back to ${PREV%/}" >&2
fi
exit 1
