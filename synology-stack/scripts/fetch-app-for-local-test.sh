#!/usr/bin/env bash
# Pull the YoutubeDL-Material app out of its published image WITHOUT Docker, so
# the GUI can be run on a dev machine that has no container runtime (some VM
# hosts do not expose nested virtualisation, so Colima/Docker/Podman won't start).
#
# It talks to the registry HTTP API directly, downloads the last few image
# layers, and extracts the /app tree - which already contains node_modules and
# the prebuilt Angular frontend. No npm install, no Angular build.
#
#   ./fetch-app-for-local-test.sh [DEST] [TAG]
#
# Then:
#   cd DEST && ytdl_use_local_db=true node app.js
#   open http://localhost:17442      (Settings is at /#/settings - hash routing)
#
# This is a test convenience, not part of the deployed stack.

set -euo pipefail

DEST="${1:-$HOME/ytdl-nightly}"
TAG="${2:-nightly}"
REPO="tzahi12345/youtubedl-material"
# How many trailing layers to consider. The app layers are the last COPY steps
# in the Dockerfile, so they sit at the end; 6 is comfortably enough.
LAYER_TAIL="${LAYER_TAIL:-6}"

case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=amd64 ;;
    *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

for cmd in curl python3 tar; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Authenticating to the registry (anonymous pull token)"
TOKEN="$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$REPO:pull" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"

api() {
    curl -fsSL -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.oci.image.index.v1+json" \
        -H "Accept: application/vnd.oci.image.manifest.v1+json" \
        -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
        -H "Accept: application/vnd.docker.distribution.manifest.v2+json" "$@"
}

echo "==> Resolving $REPO:$TAG for linux/$ARCH"
api "https://registry-1.docker.io/v2/$REPO/manifests/$TAG" >"$WORK/index.json"

DIGEST="$(ARCH="$ARCH" python3 - "$WORK/index.json" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
arch = os.environ["ARCH"]
# A single-arch manifest has "layers" directly; a multi-arch index has "manifests".
if "layers" in d:
    print("")
else:
    for m in d.get("manifests", []):
        p = m.get("platform", {})
        if p.get("architecture") == arch and p.get("os") == "linux":
            print(m["digest"]); break
    else:
        sys.exit(f"No linux/{arch} manifest in this tag")
PY
)"

if [ -n "$DIGEST" ]; then
    echo "    platform manifest: $DIGEST"
    api "https://registry-1.docker.io/v2/$REPO/manifests/$DIGEST" >"$WORK/manifest.json"
else
    echo "    single-architecture manifest"
    cp "$WORK/index.json" "$WORK/manifest.json"
fi

CREATED="$(api "https://registry-1.docker.io/v2/$REPO/blobs/$(python3 -c '
import json,sys; print(json.load(open(sys.argv[1]))["config"]["digest"])' "$WORK/manifest.json")" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created","unknown"))')"
echo "    image built: $CREATED"

# Deliberately not `mapfile` - macOS ships bash 3.2, which does not have it, and
# this script's whole purpose is running on a dev machine.
LAYER_TAIL="$LAYER_TAIL" python3 - "$WORK/manifest.json" >"$WORK/layers.txt" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
for l in d["layers"][-int(os.environ["LAYER_TAIL"]):]:
    print(l["digest"], l["size"])
PY

LAYERS=()
while IFS= read -r line; do
    [ -n "$line" ] && LAYERS+=("$line")
done <"$WORK/layers.txt"

echo "==> Downloading the last ${#LAYERS[@]} layers"
mkdir -p "$DEST"
i=0
extracted=0
# Forward order matters: later layers must overwrite earlier ones.
for entry in "${LAYERS[@]}"; do
    digest="${entry%% *}"; size="${entry##* }"
    i=$((i + 1))
    printf '    [%d/%d] %6.1f MB  ' "$i" "${#LAYERS[@]}" "$(python3 -c "print($size/1048576)")"
    blob="$WORK/layer-$i.tar.gz"
    curl -fsSL -H "Authorization: Bearer $TOKEN" \
        "https://registry-1.docker.io/v2/$REPO/blobs/$digest" -o "$blob"

    if tar -tzf "$blob" 2>/dev/null | grep -q '^app/'; then
        tar -xzf "$blob" -C "$DEST" --strip-components=1 app/ 2>/dev/null || true
        extracted=$((extracted + 1))
        echo "extracted app/"
    else
        echo "no app/ content, skipped"
    fi
done

if [ "$extracted" -eq 0 ]; then
    echo "No layer contained an app/ tree - the image layout may have changed." >&2
    exit 1
fi

echo
echo "==> Extracted to $DEST"
[ -f "$DEST/app.js" ]           && echo "    app.js           yes" || echo "    app.js           MISSING"
[ -d "$DEST/node_modules" ]     && echo "    node_modules     $(ls "$DEST/node_modules" | wc -l | tr -d ' ') packages" || echo "    node_modules     MISSING"
[ -f "$DEST/public/index.html" ] && echo "    prebuilt public/ yes" || echo "    prebuilt public/ MISSING"
echo
echo "Run it with:"
echo "    cd $DEST && ytdl_use_local_db=true node app.js"
echo "Then open http://localhost:17442   (Settings is at /#/settings)"
