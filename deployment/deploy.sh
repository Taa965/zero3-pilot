#!/usr/bin/env bash
# Idempotent atomic-release deploy for zero3-web, run ON the target host
# as the `zero3pilot` service account (never as the shared admin user).
# Safe to run repeatedly for the same or different SHAs: a failed release
# never replaces a working `current` symlink.
#
# The only privileged step is the final restart, which goes through the
# fixed, narrowly-scoped sudo entry `zero3pilot-deploy-release`
# (daemon-reload + restart zero3-pilot.service only — see
# deployment/server/bootstrap-zero3pilot.sh). This script never calls
# `sudo` for anything else.
set -euo pipefail

: "${DEPLOY_PATH:?set DEPLOY_PATH, e.g. /opt/zero3-pilot-runtime}"
: "${GIT_SHA:?set GIT_SHA of the build to release}"
: "${BUILD_ARTIFACT:?set BUILD_ARTIFACT path to the built zero3-web binary, already uploaded here}"
PORT="${ZERO3_WEB_PORT:-8788}"

RELEASE_DIR="$DEPLOY_PATH/releases/$GIT_SHA"
CURRENT_LINK="$DEPLOY_PATH/current"

mkdir -p "$RELEASE_DIR/bin"
cp "$BUILD_ARTIFACT" "$RELEASE_DIR/bin/zero3-web"
chmod +x "$RELEASE_DIR/bin/zero3-web"

PREV_TARGET=""
if [ -L "$CURRENT_LINK" ]; then
    PREV_TARGET="$(readlink -f "$CURRENT_LINK")"
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
sudo /usr/local/sbin/zero3pilot-deploy-release

ok=""
for _ in $(seq 1 10); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        ok=1
        break
    fi
    sleep 1
done

if [ -n "$ok" ]; then
    echo "zero3-pilot: health check passed for $GIT_SHA"
    exit 0
fi

echo "zero3-pilot: health check FAILED for $GIT_SHA — rolling back" >&2
if [ -n "$PREV_TARGET" ] && [ -d "$PREV_TARGET" ]; then
    ln -sfn "$PREV_TARGET" "$CURRENT_LINK"
    sudo /usr/local/sbin/zero3pilot-deploy-release
    echo "rolled back to $PREV_TARGET" >&2
else
    echo "no previous release to roll back to" >&2
fi
exit 1
