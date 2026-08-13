#!/usr/bin/env bash
# Shared helpers for the ytdlp-updater sidecar.
# Sourced by update-ytdlp.sh, rollback-ytdlp.sh and entrypoint.sh.

# ---------------------------------------------------------------------------
# Paths (all relative to /app so they match how the app itself sees appdata)
# ---------------------------------------------------------------------------
APPDATA_DIR="${APPDATA_DIR:-/app/appdata}"
BIN_DIR="$APPDATA_DIR/bin"
BACKUP_DIR="$BIN_DIR/backups"
LOG_DIR="$APPDATA_DIR/logs"
LOG_FILE="$LOG_DIR/ytdlp-updater.log"
LOCK_FILE="$APPDATA_DIR/.ytdlp-updater.lock"
# Written by rollback-ytdlp.sh. While it exists the updater will not move off
# the recorded version - otherwise the next scheduled run would immediately
# re-apply the release that was just rolled back.
HOLD_FILE="$APPDATA_DIR/.ytdlp-updater.hold"

# Read by the app's /api/ytdlpStatus endpoint to populate the top-bar widget.
# Deliberately a separate file from appdata/youtube-dl.json so this sidecar never
# has to write to the app's own bookkeeping.
STATUS_FILE="$APPDATA_DIR/ytdlp-updater-status.json"
# Written by the app when the user clicks "check now", consumed and deleted here.
# The shared appdata volume is the only channel between app and sidecar.
TRIGGER_FILE="$APPDATA_DIR/.ytdlp-updater.trigger"

# The app locates its downloader at appdata/bin/<fork>, and records what it
# thinks is installed in appdata/youtube-dl.json. See backend/youtube-dl.js.
FORK="${YTDLP_FORK:-yt-dlp}"
YTDLP_BIN="$BIN_DIR/$FORK"
DETAILS_JSON="$APPDATA_DIR/youtube-dl.json"

# ---------------------------------------------------------------------------
# Behaviour knobs (see .env.example for the user-facing documentation)
# ---------------------------------------------------------------------------
YTDLP_CHANNEL="${YTDLP_CHANNEL:-stable}"     # stable | nightly | master | <exact version>
YTDLP_FLAVOR="${YTDLP_FLAVOR:-standalone}"   # standalone | zip
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
LOG_MAX_LINES="${LOG_MAX_LINES:-5000}"
SMOKE_TEST_URL="${SMOKE_TEST_URL:-}"
COOKIE_MAX_AGE_DAYS="${COOKIE_MAX_AGE_DAYS:-30}"
PIN_APP_UPDATER="${PIN_APP_UPDATER:-true}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

PUSHOVER_ENABLED="${PUSHOVER_ENABLED:-false}"
PUSHOVER_APP_TOKEN="${PUSHOVER_APP_TOKEN:-}"
PUSHOVER_USER_KEY="${PUSHOVER_USER_KEY:-}"
PUSHOVER_NOTIFY_NOOP="${PUSHOVER_NOTIFY_NOOP:-false}"

# Release channels -> the repo that publishes them. yt-dlp splits nightly and
# master builds into their own repos; assets and SHA2-256SUMS live per-release.
REPO_STABLE="yt-dlp/yt-dlp"
REPO_NIGHTLY="yt-dlp/yt-dlp-nightly-builds"
REPO_MASTER="yt-dlp/yt-dlp-master-builds"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local level="$1"; shift
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S %Z') [$level] $*"
    echo "$line"
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    echo "$line" >>"$LOG_FILE" 2>/dev/null || true
}

info()  { log INFO  "$@"; }
warn()  { log WARN  "$@"; }
error() { log ERROR "$@"; }

# Keep the persistent log from growing without bound.
trim_log() {
    [ -f "$LOG_FILE" ] || return 0
    local lines
    lines="$(wc -l <"$LOG_FILE" 2>/dev/null || echo 0)"
    if [ "$lines" -gt "$LOG_MAX_LINES" ]; then
        tail -n "$LOG_MAX_LINES" "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null \
            && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
}

# ---------------------------------------------------------------------------
# Pushover
# ---------------------------------------------------------------------------
# notify <title> <message> [priority]
notify() {
    local title="$1" message="$2" priority="${3:-0}"

    if [ "$PUSHOVER_ENABLED" != "true" ]; then
        info "Pushover disabled, not sending: $title"
        return 0
    fi
    if [ -z "$PUSHOVER_APP_TOKEN" ] || [ -z "$PUSHOVER_USER_KEY" ]; then
        warn "Pushover enabled but PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY are unset; skipping notification."
        return 0
    fi

    local http_code
    http_code="$(curl -sS -o /dev/null -w '%{http_code}' \
        --max-time 20 \
        --form-string "token=$PUSHOVER_APP_TOKEN" \
        --form-string "user=$PUSHOVER_USER_KEY" \
        --form-string "title=$title" \
        --form-string "message=$message" \
        --form-string "priority=$priority" \
        https://api.pushover.net/1/messages.json 2>/dev/null || echo 000)"

    if [ "$http_code" = "200" ]; then
        info "Pushover sent: $title"
    else
        warn "Pushover failed (HTTP $http_code): $title"
    fi
}

# ---------------------------------------------------------------------------
# Locking - stops the scheduled loop and a manual run from colliding on the
# same binary. flock is provided by util-linux (installed in the image).
# ---------------------------------------------------------------------------
acquire_lock() {
    mkdir -p "$APPDATA_DIR" 2>/dev/null || true
    exec 9>"$LOCK_FILE" || {
        error "Cannot open lock file $LOCK_FILE - is $APPDATA_DIR writable by $(id -u):$(id -g)?"
        return 1
    }
    if ! flock -n 9; then
        warn "Another updater run holds the lock; skipping this run."
        return 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# GitHub helpers
# ---------------------------------------------------------------------------
gh_curl() {
    local url="$1"
    if [ -n "$GITHUB_TOKEN" ]; then
        curl -fsSL --max-time 30 -H "Authorization: Bearer $GITHUB_TOKEN" "$url"
    else
        curl -fsSL --max-time 30 "$url"
    fi
}

# Which repo publishes the configured channel.
channel_repo() {
    case "$YTDLP_CHANNEL" in
        nightly) echo "$REPO_NIGHTLY" ;;
        master)  echo "$REPO_MASTER" ;;
        *)       echo "$REPO_STABLE" ;;
    esac
}

# Asset filename for the configured flavor.
#   standalone -> yt-dlp_linux  (self-contained; needs no Python in the app image)
#   zip        -> yt-dlp        (Python zipapp; runs on the app image's python3)
asset_name() {
    local arch
    arch="$(uname -m)"
    if [ "$YTDLP_FLAVOR" = "zip" ]; then
        echo "yt-dlp"
        return
    fi
    case "$arch" in
        x86_64|amd64) echo "yt-dlp_linux" ;;
        aarch64|arm64) echo "yt-dlp_linux_aarch64" ;;
        armv7l) echo "yt-dlp_linux_armv7l" ;;
        *)
            warn "Unrecognised architecture '$arch'; falling back to the portable zipapp."
            echo "yt-dlp"
            ;;
    esac
}

# Resolve the version we should end up on. An explicit version in
# YTDLP_CHANNEL (e.g. 2025.01.15) is honoured verbatim.
resolve_target_version() {
    case "$YTDLP_CHANNEL" in
        stable|nightly|master) ;;
        *) echo "$YTDLP_CHANNEL"; return 0 ;;
    esac
    local repo json
    repo="$(channel_repo)"
    json="$(gh_curl "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null)" || return 1
    printf '%s' "$json" | python3 -c \
        'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null
}

# The version string the *app* will compare against. app calls
# /repos/yt-dlp/yt-dlp/tags and reads [0].name - see getLatestUpdateVersion().
resolve_app_expected_version() {
    local json
    json="$(gh_curl "https://api.github.com/repos/$REPO_STABLE/tags" 2>/dev/null)" || return 1
    printf '%s' "$json" | python3 -c \
        'import json,sys; d=json.load(sys.stdin); print(d[0]["name"] if d else "")' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Binary inspection
# ---------------------------------------------------------------------------
installed_version() {
    [ -x "$YTDLP_BIN" ] || return 1
    "$YTDLP_BIN" --version 2>/dev/null | head -n 1 | tr -d '\r'
}

# "standalone" for the PyInstaller ELF, "zip" for the Python zipapp.
installed_flavor() {
    [ -f "$YTDLP_BIN" ] || return 1
    if head -c 4 "$YTDLP_BIN" | grep -q $'\x7fELF'; then
        echo standalone
    else
        echo zip
    fi
}

desired_flavor() {
    if [ "$YTDLP_FLAVOR" = "zip" ]; then echo zip; else echo standalone; fi
}

# ---------------------------------------------------------------------------
# appdata/youtube-dl.json
# ---------------------------------------------------------------------------
# Tell the app which version is installed so its own boot-time updater treats
# the binary as current and leaves it alone. Merges into any existing file
# rather than replacing it, matching updateDetailsJSON() in youtube-dl.js.
write_details_json() {
    local version="$1"
    APPDATA_DIR="$APPDATA_DIR" DETAILS_JSON="$DETAILS_JSON" \
    FORK="$FORK" VERSION="$version" python3 - <<'PY'
import json, os

path = os.environ["DETAILS_JSON"]
fork = os.environ["FORK"]
version = os.environ["VERSION"]

data = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            data = json.load(fh) or {}
    except (ValueError, OSError):
        data = {}
if not isinstance(data, dict):
    data = {}

entry = data.get(fork) if isinstance(data.get(fork), dict) else {}
entry.update({
    "version": version,
    "downloader": fork,
    "path": os.path.join("appdata", "bin", fork),
    "exec": fork,
})
data[fork] = entry

tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh)
os.replace(tmp, path)
PY
}

details_json_version() {
    [ -f "$DETAILS_JSON" ] || return 1
    DETAILS_JSON="$DETAILS_JSON" FORK="$FORK" python3 - <<'PY' 2>/dev/null
import json, os
try:
    with open(os.environ["DETAILS_JSON"]) as fh:
        data = json.load(fh) or {}
    print((data.get(os.environ["FORK"]) or {}).get("version", ""))
except Exception:
    pass
PY
}

# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------
backup_binary() {
    [ -f "$YTDLP_BIN" ] || { info "No existing binary to back up."; return 0; }
    mkdir -p "$BACKUP_DIR"

    local version stamp dest
    version="$(installed_version || echo unknown)"
    stamp="$(date '+%Y%m%d-%H%M%S')"
    dest="$BACKUP_DIR/$FORK.$version.$stamp"

    cp -p "$YTDLP_BIN" "$dest" || { error "Backup to $dest failed."; return 1; }
    # Stable "last known good" pointer, as well as the versioned history.
    cp -p "$YTDLP_BIN" "$BIN_DIR/$FORK.bak"
    info "Backed up current binary ($version) to $dest"
    prune_backups
}

prune_backups() {
    [ -d "$BACKUP_DIR" ] || return 0
    local count
    count="$(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$count" -gt "$KEEP_BACKUPS" ]; then
        # Names end in a sortable -YYYYmmdd-HHMMSS stamp, so lexical order is chronological.
        ls -1 "$BACKUP_DIR" | sort | head -n "$((count - KEEP_BACKUPS))" | while read -r old; do
            rm -f "$BACKUP_DIR/$old" && info "Pruned old backup $old"
        done
    fi
}

list_backups() {
    [ -d "$BACKUP_DIR" ] || return 1
    ls -1 "$BACKUP_DIR" 2>/dev/null | sort
}

# Newest backup recorded for a given version string, if any.
find_backup_for() {
    local version="$1" name
    [ -d "$BACKUP_DIR" ] || return 1
    name="$(ls -1 "$BACKUP_DIR" 2>/dev/null \
        | awk -v p="$FORK.$version." 'index($0, p) == 1' | sort | tail -n 1)"
    [ -n "$name" ] || return 1
    echo "$BACKUP_DIR/$name"
}

# Put an already-downloaded/known binary into place: verify it runs, then swap
# it in atomically (same filesystem) so the app never sees a partial file.
install_binary_file() {
    local src="$1"
    local tmp="$BIN_DIR/.$FORK.staged.$$"

    cp -p "$src" "$tmp" || { error "Could not stage $src"; return 1; }
    chmod 0755 "$tmp"
    if ! verify_binary "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    mv -f "$tmp" "$YTDLP_BIN" || { rm -f "$tmp"; error "Could not move staged binary into place."; return 1; }
    chmod 0755 "$YTDLP_BIN"
    return 0
}

# ---------------------------------------------------------------------------
# Status file consumed by the app's top-bar widget
# ---------------------------------------------------------------------------
# write_status_json <result> [did_update]
#
# <result> is a short machine-readable outcome: updated | no-change | failed |
# rolled-back | held. last_update is only advanced when did_update is "true";
# otherwise the previous value is carried forward, so the widget can show when
# the binary actually last changed rather than when it was last checked.
write_status_json() {
    local result="$1" did_update="${2:-false}"
    local installed held recorded
    installed="$(installed_version || echo '')"
    held="$(held_version || echo '')"
    recorded="$(details_json_version || echo '')"

    STATUS_FILE="$STATUS_FILE" \
    INSTALLED="$installed" \
    RECORDED="$recorded" \
    HELD="$held" \
    CHANNEL="$YTDLP_CHANNEL" \
    FLAVOR="$(installed_flavor || echo '')" \
    RESULT="$result" \
    DID_UPDATE="$did_update" \
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    BACKUPS="$(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')" \
    INTERVAL="${UPDATE_INTERVAL_HOURS:-12}" \
    python3 - <<'PY'
import json, os

path = os.environ["STATUS_FILE"]
now = os.environ["NOW"]

previous = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            previous = json.load(fh) or {}
    except (ValueError, OSError):
        previous = {}
if not isinstance(previous, dict):
    previous = {}

def opt(name):
    value = os.environ.get(name, "")
    return value if value else None

status = {
    "installed_version": opt("INSTALLED"),
    "app_recorded_version": opt("RECORDED"),
    "channel": opt("CHANNEL"),
    "flavor": opt("FLAVOR"),
    "held_version": opt("HELD"),
    "last_check": now,
    "last_update": now if os.environ.get("DID_UPDATE") == "true" else previous.get("last_update"),
    "last_result": opt("RESULT"),
    "backups": int(os.environ.get("BACKUPS") or 0),
    "interval_hours": int(os.environ.get("INTERVAL") or 12),
}

tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(status, fh)
os.replace(tmp, path)
PY
}

# ---------------------------------------------------------------------------
# Version hold (set by a rollback)
# ---------------------------------------------------------------------------
held_version() {
    [ -f "$HOLD_FILE" ] || return 1
    local v
    v="$(head -n 1 "$HOLD_FILE" 2>/dev/null | tr -d '\r\n')"
    [ -n "$v" ] || return 1
    echo "$v"
}

set_hold() {
    echo "$1" >"$HOLD_FILE" && info "Hold set: updater will stay on $1 until the hold is cleared."
}

clear_hold() {
    if [ -f "$HOLD_FILE" ]; then
        rm -f "$HOLD_FILE" && info "Hold cleared; normal updates resume on the next run."
    else
        info "No hold was set."
    fi
}

# ---------------------------------------------------------------------------
# Install / verify
# ---------------------------------------------------------------------------
# Download <asset> for <version> and verify it against the release's own
# SHA2-256SUMS before it is allowed anywhere near appdata/bin.
# fetch_verified_asset <repo> <version> <asset> <dest>
fetch_verified_asset() {
    local repo="$1" version="$2" asset="$3" dest="$4"
    local base="https://github.com/$repo/releases/download/$version"

    info "Downloading $asset ($version) from $repo"
    if ! curl -fsSL --max-time 300 -o "$dest" "$base/$asset"; then
        error "Download of $asset failed."
        return 1
    fi

    local sums expected actual
    sums="$(curl -fsSL --max-time 60 "$base/SHA2-256SUMS" 2>/dev/null)" || {
        error "Could not fetch SHA2-256SUMS for $version; refusing to install an unverified binary."
        rm -f "$dest"
        return 1
    }
    expected="$(printf '%s\n' "$sums" | awk -v a="$asset" '$2 == a || $2 == "*"a {print $1; exit}')"
    if [ -z "$expected" ]; then
        error "No checksum listed for $asset in $version; refusing to install."
        rm -f "$dest"
        return 1
    fi
    actual="$(sha256sum "$dest" | awk '{print $1}')"
    if [ "$expected" != "$actual" ]; then
        error "Checksum mismatch for $asset (expected $expected, got $actual); discarding download."
        rm -f "$dest"
        return 1
    fi
    info "Checksum verified for $asset"
    return 0
}

# A binary is only considered good if it actually executes and reports a version.
verify_binary() {
    local path="$1"
    local out
    if ! out="$("$path" --version 2>&1 | head -n 1 | tr -d '\r')" || [ -z "$out" ]; then
        error "Sanity check failed: '$path --version' did not run. Output: ${out:-<none>}"
        return 1
    fi
    info "Sanity check passed: $path reports $out"
    return 0
}

# Optional end-to-end check against a real URL. Metadata only, nothing is
# downloaded. Off unless SMOKE_TEST_URL is set.
smoke_test() {
    [ -n "$SMOKE_TEST_URL" ] || return 0
    info "Running smoke test against $SMOKE_TEST_URL"
    if "$YTDLP_BIN" --simulate --no-warnings --no-playlist "$SMOKE_TEST_URL" >/dev/null 2>&1; then
        info "Smoke test passed."
        return 0
    fi
    error "Smoke test failed for $SMOKE_TEST_URL"
    return 1
}

# Cookies expire quietly and look like "site not supported" failures later on.
check_cookies() {
    local cookies="$APPDATA_DIR/cookies.txt"
    [ -f "$cookies" ] || return 0
    local age_days
    age_days="$(( ( $(date +%s) - $(stat -c %Y "$cookies") ) / 86400 ))"
    if [ "$age_days" -ge "$COOKIE_MAX_AGE_DAYS" ]; then
        warn "cookies.txt is ${age_days} days old (threshold ${COOKIE_MAX_AGE_DAYS}). Stale cookies show up as auth-wall download failures - consider re-exporting."
        return 1
    fi
    info "cookies.txt is ${age_days} days old."
    return 0
}

# The v4.3.2 image (upstream's `latest`, built 2023-05-27) keeps its downloader
# at node_modules/youtube-dl/bin/ inside the container rather than in appdata/.
# Against that image this sidecar would run happily and accomplish nothing - the
# app would never look at the binary we manage. There is no way to see into the
# app container from here, so warn on the one observable signature: no details
# file and no binary, which is also what a genuinely fresh deploy looks like.
check_app_layout() {
    if [ ! -f "$DETAILS_JSON" ] && [ ! -f "$YTDLP_BIN" ]; then
        warn "Neither $DETAILS_JSON nor $YTDLP_BIN exists yet. Normal on a first run - but if it persists after the app has started, the app image is probably the v4.3.2 'latest' tag, which stores its downloader inside the container where this sidecar cannot manage it. Check APP_IMAGE_TAG (should be 'nightly' or a nightly-YYYY-MM-DD pin)."
    fi
}

preflight() {
    mkdir -p "$BIN_DIR" "$LOG_DIR" 2>/dev/null || true
    if [ ! -w "$BIN_DIR" ]; then
        error "$BIN_DIR is not writable by uid $(id -u) gid $(id -g). Set PUID/PGID in .env to match the owner of appdata (the app image defaults to 1000:1000)."
        return 1
    fi
    for cmd in curl python3 sha256sum flock; do
        command -v "$cmd" >/dev/null 2>&1 || { error "Required command '$cmd' is missing from the image."; return 1; }
    done
    return 0
}
