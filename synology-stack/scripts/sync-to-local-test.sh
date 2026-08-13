#!/usr/bin/env bash
# Copy this fork's backend (and, if built, frontend) over a local test instance
# created by fetch-app-for-local-test.sh, then restart it.
#
# Lets backend changes be exercised against the real app without Docker and
# without an npm install - the test instance already has node_modules from the
# published image.
#
#   ./sync-to-local-test.sh [DEST]
#
# Frontend changes need `npm run build` at the repo root first, which writes to
# backend/public; this copies that over if it is present.

set -euo pipefail

DEST="${1:-$HOME/ytdl-nightly}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$REPO_ROOT/backend"

[ -d "$DEST" ] || { echo "No test instance at $DEST - run fetch-app-for-local-test.sh first." >&2; exit 1; }
[ -d "$BACKEND" ] || { echo "No backend/ found at $BACKEND" >&2; exit 1; }

echo "==> Stopping any running instance"
pkill -f "node app.js" 2>/dev/null || true
sleep 1

echo "==> Syncing backend sources from $BACKEND"
# Top-level .js files plus the subdirectories that hold real code. node_modules,
# public and appdata are deliberately excluded: node_modules comes from the
# image, public is built separately, and appdata is the test instance's state.
find "$BACKEND" -maxdepth 1 -name '*.js' -exec cp {} "$DEST/" \;
for dir in authentication subscriptions fix-scripts; do
    [ -d "$BACKEND/$dir" ] && cp -R "$BACKEND/$dir" "$DEST/"
done
echo "    $(find "$BACKEND" -maxdepth 1 -name '*.js' | wc -l | tr -d ' ') js files"

if [ -d "$BACKEND/public" ] && [ -f "$BACKEND/public/index.html" ]; then
    echo "==> Syncing built frontend from backend/public"
    rm -rf "$DEST/public"
    cp -R "$BACKEND/public" "$DEST/public"
    echo "    $(ls "$DEST/public" | wc -l | tr -d ' ') entries"
else
    echo "==> No built frontend at backend/public - keeping the image's copy"
    echo "    (run 'npm run build' at the repo root to build it)"
fi

echo "==> Starting"
cd "$DEST"
ytdl_use_local_db=true nohup node app.js >/tmp/ytdl-run.log 2>&1 &
for _ in $(seq 1 15); do
    sleep 2
    if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:17442 2>/dev/null)" = "200" ]; then
        echo "    up at http://localhost:17442"
        exit 0
    fi
done

echo "    did not come up - last log lines:" >&2
tail -20 /tmp/ytdl-run.log >&2
exit 1
