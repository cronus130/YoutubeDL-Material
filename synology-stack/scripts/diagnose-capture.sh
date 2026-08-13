#!/usr/bin/env bash
# Pins down where a capture from the Firefox extension is getting lost.
#
# Three separate things can go wrong and they look identical from the GUI:
#
#   1. the capture never reaches the backend      -> extension URL/API key
#   2. it reaches it but the queue query hides it -> the /api/downloads filter
#   3. it downloads but no file record appears    -> library/thumbnail handling
#
# Send a capture from the extension FIRST, then run this within a minute or so.
#
#   ./diagnose-capture.sh [BASE_URL] [API_KEY]
#
# Defaults to the local test instance and its hardcoded admin token.

set -uo pipefail

BASE="${1:-http://localhost:17442}"
KEY="${2:-4241b401-7236-493e-92b5-b72696b9d853}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Responses go to files and the Python reads them by path. Piping into a heredoc
# would collide on stdin, and inlining the program with -c means fighting two
# levels of quoting.
post() {
    curl -s -X POST "$BASE/api/$1?apiKey=$KEY" \
        -H 'Content-Type: application/json' -d "$2" -o "$TMP/$3"
}

echo "=== 1. is the backend running this fork, and is the key accepted? ==="
probe="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/capture?apiKey=$KEY" \
    -H 'Content-Type: application/json' -d '{}')"
case "$probe" in
    400) echo "   ok    /api/capture exists and the key works (400 = empty body rejected)" ;;
    404) echo "   FAIL  404 - this instance is not running the fork build" ;;
    000) echo "   FAIL  no response - wrong URL/port, or a bad API key (which closes the socket)" ;;
    *)   echo "   ?     unexpected HTTP $probe" ;;
esac

echo
echo "=== 2. FULL queue, no uid filter - what the Downloads page sees ==="
post downloads '{}' full.json
python3 - "$TMP/full.json" <<'PY'
import json, sys
try:
    rows = json.load(open(sys.argv[1])).get("downloads") or []
except Exception as exc:
    print("   could not parse:", exc)
    print("   raw:", open(sys.argv[1]).read()[:200])
    raise SystemExit
if not rows:
    print("   (queue is empty)")
for row in rows[-6:]:
    state = "error" if row.get("error") else ("done" if row.get("finished") else "ACTIVE")
    print("   {:<7} step={} pct={} user_uid={!r} sub_id={!r}".format(
        state, row.get("step_index"), row.get("percent_complete"),
        row.get("user_uid"), row.get("sub_id")))
    print("           title={}".format((row.get("title") or "(none)")[:56]))
    print("           url  ={}".format((row.get("url") or "")[:80]))
    if row.get("error"):
        first = (row.get("error") or "").splitlines()
        print("           err  ={}".format(first[0][:100] if first else ""))
PY

echo
echo "=== 3. FILTERED query - exactly what the home page asks for ==="
echo "    (it sends the uids it started itself; a capture is never among them)"
post downloads '{"uids":["uid-that-does-not-exist"]}' filtered.json
python3 - "$TMP/filtered.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1])).get("downloads") or []
print("   returned {} row(s)".format(len(rows)))
for row in rows:
    state = "error" if row.get("error") else ("done" if row.get("finished") else "ACTIVE")
    print("   {:<7} {}".format(state, (row.get("title") or row.get("url") or "")[:64]))
if not rows:
    print("   -> the home page cannot see anything. If step 2 showed an ACTIVE row,")
    print("      either the /api/downloads fix is not loaded (restart the app), or")
    print("      user_uid differs between the GUI session and the capture.")
PY

echo
echo "=== 4. library records - what My files shows ==="
post getAllFiles '{}' files.json
python3 - "$TMP/files.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception as exc:
    print("   could not parse:", exc)
    print("   raw:", open(sys.argv[1]).read()[:200])
    raise SystemExit
files = data.get("files")
if files is None:
    print("   unexpected shape; top-level keys:", list(data.keys()))
    raise SystemExit
print("   {} file record(s)".format(len(files)))
for f in files[-6:]:
    has_thumb = bool(f.get("thumbnailURL") or f.get("thumbnailPath"))
    print("   thumb={:<5} {}".format(str(has_thumb), (f.get("title") or "")[:56]))
PY

echo
echo "Done. Paste the whole output back."
