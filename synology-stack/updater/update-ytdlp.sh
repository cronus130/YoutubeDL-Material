#!/usr/bin/env bash
# Back up -> update -> verify -> record -> notify.
#
# Two update paths, both checksum-verified:
#   * yt-dlp's own self-updater (--update-to) when the installed binary already
#     matches the configured flavor. This is yt-dlp's supported mechanism and
#     verifies the download against the release's SHA2-256SUMS itself.
#   * A direct verified download when the binary is missing, is the wrong
#     flavor, or the self-updater refuses. We check SHA2-256SUMS ourselves, so
#     nothing unverified ever lands in appdata/bin.
#
# On any failure after the binary was touched, the previous binary is restored.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

restore_backup() {
    if [ -f "$BIN_DIR/$FORK.bak" ]; then
        cp -p "$BIN_DIR/$FORK.bak" "$YTDLP_BIN" && chmod 0755 "$YTDLP_BIN"
        warn "Restored previous binary from $FORK.bak"
        return 0
    fi
    error "No $FORK.bak available to restore."
    return 1
}

# Fresh verified install of <version>, replacing whatever is there now.
install_version() {
    local version="$1"
    local repo asset tmp
    repo="$(channel_repo)"
    asset="$(asset_name)"
    tmp="$BIN_DIR/.$FORK.download.$$"

    if ! fetch_verified_asset "$repo" "$version" "$asset" "$tmp"; then
        rm -f "$tmp"
        return 1
    fi

    chmod 0755 "$tmp"
    if ! verify_binary "$tmp"; then
        rm -f "$tmp"
        return 1
    fi

    # Same filesystem, so this is an atomic swap - the app can never see a
    # half-written binary (which is exactly how the app's own downloader fails).
    mv -f "$tmp" "$YTDLP_BIN" || { rm -f "$tmp"; error "Could not move new binary into place."; return 1; }
    chmod 0755 "$YTDLP_BIN"
    return 0
}

main() {
    preflight || exit 1
    acquire_lock || exit 0
    trim_log

    info "===== ytdlp-updater run starting (channel=$YTDLP_CHANNEL flavor=$YTDLP_FLAVOR) ====="
    check_app_layout

    local before flavor_now flavor_want target changed=false action=""
    before="$(installed_version || echo none)"
    flavor_now="$(installed_flavor || echo none)"
    flavor_want="$(desired_flavor)"
    info "Currently installed: version=$before flavor=$flavor_now"

    # A hold means someone rolled back deliberately. Do not update past it;
    # only make sure the held version is still the one on disk, in case the
    # app's own updater replaced it.
    local hold
    if hold="$(held_version)"; then
        info "Hold is active on $hold - skipping the update check."
        if [ "$before" != "$hold" ]; then
            warn "Held version $hold is not what is installed ($before); attempting to restore it."
            local backup
            if backup="$(find_backup_for "$hold")" && install_binary_file "$backup"; then
                info "Restored held version $hold."
                notify "yt-dlp hold re-applied" "The binary had drifted to $before; $hold was restored from backup. The hold is still active." 1
            else
                error "Could not restore held version $hold (no usable backup found)."
                notify "yt-dlp hold BROKEN" "The updater is held on $hold but $before is installed and no matching backup could be restored. Manual attention needed." 1
            fi
        fi
        if [ "$PIN_APP_UPDATER" = "true" ]; then
            local held_expected
            held_expected="$(resolve_app_expected_version || true)"
            write_details_json "${held_expected:-$hold}"
        fi
        check_cookies || true
        write_status_json held
        info "===== ytdlp-updater run finished (held) ====="
        exit 0
    fi

    target="$(resolve_target_version || true)"
    if [ -z "$target" ]; then
        error "Could not resolve the target version for channel '$YTDLP_CHANNEL' (GitHub API unreachable or rate-limited)."
        notify "yt-dlp update FAILED" "Could not reach the GitHub API to resolve the latest $YTDLP_CHANNEL version. Binary left untouched at $before." 0
        write_status_json failed
        exit 1
    fi
    info "Target version for channel '$YTDLP_CHANNEL': $target"

    if [ "$before" = "$target" ] && [ "$flavor_now" = "$flavor_want" ]; then
        info "Already up to date."
        action="noop"
    else
        # Anything that changes the binary gets a backup first.
        backup_binary || { error "Aborting: could not back up the current binary."; \
            notify "yt-dlp update FAILED" "Backup of the current binary failed; no update was attempted. Still on $before." 1; \
            write_status_json failed; exit 1; }

        if [ "$flavor_now" = "$flavor_want" ] && [ "$before" != "none" ]; then
            # Let yt-dlp update itself.
            local spec
            case "$YTDLP_CHANNEL" in
                stable|nightly|master) spec="$YTDLP_CHANNEL" ;;
                *) spec="stable@$YTDLP_CHANNEL" ;;
            esac
            info "Attempting self-update: $FORK --update-to $spec"
            local out
            out="$("$YTDLP_BIN" --update-to "$spec" 2>&1)"
            info "self-update output: $(printf '%s' "$out" | tr '\n' '|')"

            local after_self
            after_self="$(installed_version || echo none)"
            if [ "$after_self" = "$target" ]; then
                action="self-update"
            else
                warn "Self-update did not reach $target (now on $after_self); falling back to a verified direct install."
                install_version "$target" || {
                    error "Verified install failed."
                    restore_backup
                    notify "yt-dlp update FAILED" "Both the self-updater and the verified download failed while moving $before -> $target. Previous binary restored." 1
                    write_status_json failed
                    exit 1
                }
                action="verified-install"
            fi
        else
            if [ "$flavor_now" != "none" ] && [ "$flavor_now" != "$flavor_want" ]; then
                info "Installed flavor '$flavor_now' does not match desired '$flavor_want'; reinstalling."
            fi
            install_version "$target" || {
                error "Verified install failed."
                [ "$before" != "none" ] && restore_backup
                notify "yt-dlp update FAILED" "Verified install of $target failed. $( [ "$before" != none ] && echo "Previous binary ($before) restored." || echo "No binary is installed." )" 1
                write_status_json failed
                exit 1
            }
            action="verified-install"
        fi

        changed=true
    fi

    # Post-change validation. A binary that does not run, or fails the optional
    # smoke test, is rolled straight back.
    if [ "$changed" = true ]; then
        if ! verify_binary "$YTDLP_BIN"; then
            restore_backup
            notify "yt-dlp update ROLLED BACK" "New version $target failed its --version sanity check. Reverted to $before." 1
            write_status_json rolled-back
            exit 1
        fi
        if ! smoke_test; then
            restore_backup
            notify "yt-dlp update ROLLED BACK" "New version $target installed but the smoke test against $SMOKE_TEST_URL failed. Reverted to $before." 1
            write_status_json rolled-back
            exit 1
        fi
        # Only promote to last-known-good once it has passed everything.
        cp -p "$YTDLP_BIN" "$BIN_DIR/$FORK.last-good" 2>/dev/null || true
    fi

    local after
    after="$(installed_version || echo unknown)"

    # Keep the app's own updater quiet. It compares appdata/youtube-dl.json
    # against the newest tag on yt-dlp/yt-dlp and re-downloads (unverified) on
    # any mismatch, which would clobber whatever we just installed.
    if [ "$PIN_APP_UPDATER" = "true" ]; then
        local expected
        expected="$(resolve_app_expected_version || true)"
        if [ -n "$expected" ]; then
            write_details_json "$expected"
            if [ "$expected" != "$after" ]; then
                info "Recorded '$expected' in youtube-dl.json to satisfy the app's updater (actually running $after)."
            else
                info "Recorded '$expected' in youtube-dl.json."
            fi
        else
            warn "Could not resolve the tag the app expects; writing the installed version instead. The app may re-download on its next restart."
            write_details_json "$after"
        fi
    else
        write_details_json "$after"
        warn "PIN_APP_UPDATER=false - the app's boot-time updater may replace this binary."
    fi

    check_cookies || true

    if [ "$changed" = true ]; then
        info "Update complete: $before -> $after via $action"
        write_status_json updated true
        notify "yt-dlp updated" "$before -> $after
Channel: $YTDLP_CHANNEL ($YTDLP_FLAVOR)
Method: $action
Verified and sanity-checked. Previous binary kept for rollback." 0
    else
        info "No change; still on $after"
        write_status_json no-change
        if [ "$PUSHOVER_NOTIFY_NOOP" = "true" ]; then
            notify "yt-dlp already up to date" "Still on $after (channel $YTDLP_CHANNEL)." -1
        fi
    fi

    info "===== ytdlp-updater run finished ====="
}

main "$@"
