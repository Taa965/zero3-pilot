#!/usr/bin/env bash
# Atomic routine release deploy. Run as the dedicated `zero3memory` service
# account after one-time bootstrap; do not run routine releases as root.
set -euo pipefail

: "${GIT_SHA:?set GIT_SHA of the build to release}"
: "${BUILD_ARTIFACT:?set BUILD_ARTIFACT path to the built zero3-memory-server binary}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/zero3-memory-runtime}"
PORT="${ZERO3_MEMORY_PORT:-8790}"

if [[ "$(id -un)" != 'zero3memory' ]]; then
  echo 'Routine Memory Authority deploy must run as the zero3memory service account.' >&2
  exit 1
fi
if [[ ! -f "$BUILD_ARTIFACT" || ! -x "$BUILD_ARTIFACT" ]]; then
  echo "Build artifact is missing or not executable: $BUILD_ARTIFACT" >&2
  exit 1
fi

release_dir="$DEPLOY_PATH/releases/$GIT_SHA"
current_link="$DEPLOY_PATH/current"
mkdir -p "$release_dir/bin"
cp "$BUILD_ARTIFACT" "$release_dir/bin/zero3-memory-server"
chmod 0755 "$release_dir/bin/zero3-memory-server"

previous=''
if [[ -L "$current_link" ]]; then
  previous="$(readlink -f "$current_link")"
fi

ln -sfn "$release_dir" "$current_link"
sudo /usr/local/sbin/zero3memory-deploy-release

healthy=''
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/ready" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.5
done

if [[ -n "$healthy" ]]; then
  echo "zero3-memory-authority: readiness passed for $GIT_SHA"
  exit 0
fi

echo "zero3-memory-authority: readiness FAILED for $GIT_SHA — rolling back" >&2
if [[ -n "$previous" && -d "$previous" ]]; then
  ln -sfn "$previous" "$current_link"
  sudo /usr/local/sbin/zero3memory-deploy-release
  echo "rolled back to $previous" >&2
else
  echo 'no previous release is available for rollback' >&2
fi
exit 1
