#!/usr/bin/env bash
# Launches Firefox Developer Edition with this extension loaded and reloads it
# whenever a file changes.
#
# Faster than rebuild-and-reinstall while we are iterating on capture behaviour.
# The trade-off vs. installing the unsigned .xpi: web-ext loads the extension
# temporarily, so it is gone when Firefox closes.
#
# --firefox-profile + --keep-profile-changes reuse a real profile, so logins and
# cookies on the sites being tested persist between runs. That matters here: the
# whole point is capturing session context, and a throwaway profile is logged out
# of everything.
#
#   ./dev-run.sh                 use the dedicated ytdlm-capture profile
#   ./dev-run.sh <profile-name>  use a specific profile

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

FIREFOX="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
PROFILE="${1:-ytdlm-capture}"

[ -x "$FIREFOX" ] || { echo "Firefox Developer Edition not found at $FIREFOX" >&2; exit 1; }

echo "Launching with profile '$PROFILE' (created on first run)."
echo "Log into the sites you want to test in this window - the profile persists."
echo

exec npx --yes web-ext@8 run \
    --firefox="$FIREFOX" \
    --firefox-profile="$PROFILE" \
    --profile-create-if-missing \
    --keep-profile-changes \
    --source-dir . \
    --browser-console
