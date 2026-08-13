#!/usr/bin/env bash
# Builds the .zip to upload to addons.mozilla.org.
#
# AMO wants the manifest at the archive root, not inside a folder, which is the
# usual way this goes wrong. Run from this directory.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
OUT="../ytdlm-capture-${VERSION}.zip"

FILES=(manifest.json background.js metadata.js popup.html popup.css popup.js options.html options.js)

for file in "${FILES[@]}"; do
    [ -f "$file" ] || { echo "Missing $file" >&2; exit 1; }
done

rm -f "$OUT"
# -X strips extended attributes and resource forks, which macOS would otherwise
# add and AMO would flag as unexpected files.
zip -q -X "$OUT" "${FILES[@]}"

# An .xpi is just a zip. Firefox will install this one directly on Developer
# Edition / Nightly / ESR with xpinstall.signatures.required=false, which is the
# way to test while an AMO review is pending.
XPI="${OUT%.zip}-unsigned.xpi"
cp "$OUT" "$XPI"

echo "Built:"
echo "  $(cd .. && pwd)/$(basename "$OUT")          <- upload this to AMO"
echo "  $(cd .. && pwd)/$(basename "$XPI")  <- install this in Developer Edition"
echo
echo "Contents (manifest.json must be at the root):"
unzip -Z1 "$OUT" | sed 's/^/  /'
