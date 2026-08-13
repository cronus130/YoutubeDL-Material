#!/usr/bin/env bash
# Restore a previously-known-good yt-dlp binary and pin the updater to it.
#
#   rollback-ytdlp.sh                 restore the most recent backup
#   rollback-ytdlp.sh --list          show what can be restored
#   rollback-ytdlp.sh --to <name>     restore a specific backup from bin/backups
#   rollback-ytdlp.sh --last-good     restore the last binary that passed verification
#   rollback-ytdlp.sh --release       clear the hold and resume normal updates
#
# A successful rollback writes a hold file, so the scheduled updater will not
# immediately re-install the release you just backed away from. Clear it with
# --release once the upstream problem is fixed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
    local mode=newest target_name=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --list)      mode=list ;;
            --last-good) mode=last-good ;;
            --release|--clear-hold) mode=release ;;
            --to)        mode=named; target_name="${2:-}"; shift ;;
            -h|--help)   usage; exit 0 ;;
            *)           error "Unknown argument '$1'"; usage; exit 2 ;;
        esac
        shift
    done

    preflight || exit 1

    if [ "$mode" = list ]; then
        echo "Current: $(installed_version || echo none) (flavor $(installed_flavor || echo none))"
        local hold
        if hold="$(held_version)"; then echo "Hold:    $hold"; else echo "Hold:    none"; fi
        echo
        echo "Backups in $BACKUP_DIR:"
        list_backups | sed 's/^/  /' || echo "  (none)"
        echo
        [ -f "$BIN_DIR/$FORK.last-good" ] \
            && echo "last-good: $("$BIN_DIR/$FORK.last-good" --version 2>/dev/null || echo unreadable)" \
            || echo "last-good: (none)"
        [ -f "$BIN_DIR/$FORK.bak" ] \
            && echo "bak:       $("$BIN_DIR/$FORK.bak" --version 2>/dev/null || echo unreadable)" \
            || echo "bak:       (none)"
        exit 0
    fi

    acquire_lock || exit 1

    if [ "$mode" = release ]; then
        clear_hold
        write_status_json hold-released
        notify "yt-dlp hold cleared" "Automatic updates resume on the next scheduled run." -1
        exit 0
    fi

    local before source_path
    before="$(installed_version || echo none)"

    case "$mode" in
        newest)
            source_path="$(list_backups | tail -n 1 || true)"
            if [ -n "$source_path" ]; then
                source_path="$BACKUP_DIR/$source_path"
            elif [ -f "$BIN_DIR/$FORK.bak" ]; then
                source_path="$BIN_DIR/$FORK.bak"
            fi
            ;;
        last-good)
            source_path="$BIN_DIR/$FORK.last-good"
            ;;
        named)
            if [ -z "$target_name" ]; then error "--to requires a backup name (see --list)."; exit 2; fi
            source_path="$BACKUP_DIR/$target_name"
            ;;
    esac

    if [ -z "${source_path:-}" ] || [ ! -f "$source_path" ]; then
        error "Nothing to roll back to (looked for ${source_path:-a backup}). Run --list to see what exists."
        notify "yt-dlp rollback FAILED" "No usable backup was found, so nothing was changed. Still on $before." 1
        exit 1
    fi

    info "Rolling back from $before using $source_path"
    if ! install_binary_file "$source_path"; then
        error "Rollback failed; the binary was left as-is."
        notify "yt-dlp rollback FAILED" "Backup $(basename "$source_path") would not verify. Still on $before." 1
        exit 1
    fi

    local after
    after="$(installed_version || echo unknown)"
    set_hold "$after"

    # Keep the app's own updater from undoing this on its next restart.
    if [ "$PIN_APP_UPDATER" = "true" ]; then
        local expected
        expected="$(resolve_app_expected_version || true)"
        write_details_json "${expected:-$after}"
    else
        write_details_json "$after"
    fi

    write_status_json rolled-back true
    info "Rollback complete: $before -> $after (held)"
    notify "yt-dlp rolled back" "$before -> $after
Restored from: $(basename "$source_path")
The updater is now held on $after. Run rollback-ytdlp.sh --release to resume automatic updates." 1
}

main "$@"
