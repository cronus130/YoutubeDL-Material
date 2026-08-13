#!/usr/bin/env bash
# Scheduler for the updater sidecar: run the update check, sleep, repeat.
#
# A plain loop rather than cron so that everything lands in `docker logs` and
# there is no second process to supervise. A failed run never kills the loop -
# it is logged, notified, and retried on the next cycle.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

UPDATE_INTERVAL_HOURS="${UPDATE_INTERVAL_HOURS:-12}"
RUN_ON_START="${RUN_ON_START:-true}"
STARTUP_DELAY_SECONDS="${STARTUP_DELAY_SECONDS:-60}"
# How often to look for a "check now" request from the web UI. This is a local
# file stat, not a network call, so it is cheap to poll often.
TRIGGER_POLL_SECONDS="${TRIGGER_POLL_SECONDS:-10}"

# One-shot mode, for `docker compose run --rm ytdlp-updater check` and for
# invoking the scripts by hand from the host.
case "${1:-loop}" in
    check|update|once)
        exec "$SCRIPT_DIR/update-ytdlp.sh"
        ;;
    rollback)
        shift
        exec "$SCRIPT_DIR/rollback-ytdlp.sh" "$@"
        ;;
    shell|bash)
        exec bash
        ;;
    loop) ;;
    *)
        exec "$@"
        ;;
esac

interval_seconds=$(( UPDATE_INTERVAL_HOURS * 3600 ))
if [ "$interval_seconds" -lt 3600 ]; then
    warn "UPDATE_INTERVAL_HOURS=$UPDATE_INTERVAL_HOURS is very aggressive; clamping to 1 hour to stay clear of GitHub API rate limits."
    interval_seconds=3600
fi

info "ytdlp-updater sidecar started (interval ${UPDATE_INTERVAL_HOURS}h, channel $YTDLP_CHANNEL, flavor $YTDLP_FLAVOR, uid $(id -u):$(id -g))"

# Terminate promptly on `docker stop` instead of waiting out a sleep. Set before
# the startup delay so an immediate stop is honoured too.
trap 'info "Shutting down."; exit 0' TERM INT

if [ "$RUN_ON_START" = "true" ]; then
    # Let the app container finish its own boot-time binary check first,
    # otherwise the two race over appdata/bin on every stack restart.
    info "Waiting ${STARTUP_DELAY_SECONDS}s before the first check so the app finishes starting."
    sleep "$STARTUP_DELAY_SECONDS" &
    wait $! || true
    "$SCRIPT_DIR/update-ytdlp.sh" || warn "Startup update check exited non-zero; continuing."
else
    info "RUN_ON_START=false - first check in ${UPDATE_INTERVAL_HOURS}h."
fi

# Sleep in short slices rather than one long sleep, so a "check now" click in the
# web UI is picked up within seconds instead of waiting out the interval. The
# jitter keeps repeated restarts from all hitting GitHub on the same minute.
next_run=$(( $(date +%s) + interval_seconds + (RANDOM % 300) ))

while true; do
    sleep "$TRIGGER_POLL_SECONDS" &
    wait $! || true

    now="$(date +%s)"

    if [ -f "$TRIGGER_FILE" ]; then
        # Remove it first: if the run fails we do not want to loop on it forever.
        rm -f "$TRIGGER_FILE"
        info "Update check requested from the web UI."
        "$SCRIPT_DIR/update-ytdlp.sh" || warn "Requested update check exited non-zero."
        next_run=$(( now + interval_seconds + (RANDOM % 300) ))
    elif [ "$now" -ge "$next_run" ]; then
        "$SCRIPT_DIR/update-ytdlp.sh" || warn "Update check exited non-zero; will retry next cycle."
        next_run=$(( now + interval_seconds + (RANDOM % 300) ))
    fi
done
