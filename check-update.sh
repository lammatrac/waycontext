#!/usr/bin/env bash
# Update check: fetches from origin and, if behind, notifies at most once
# per calendar day. Read-only — never pulls or runs install.sh; run
# ./update.sh yourself to actually update.
#
# Meant to be cron'd every 5 minutes rather than at a fixed time of day —
# a personal laptop isn't guaranteed to be on at any particular hour, so
# frequent-but-quiet is more reliable than once-daily-but-maybe-missed.
# The 5-minute run is just a cheap `git fetch` + compare; the once/day
# debounce (via last-notified-date) is what keeps it from spamming a
# notification (or a growing log) 288 times a day.
#
# Usage:
#   ./check-update.sh              run the check once (this is what cron calls);
#                                  in a terminal it also prints the result
#   ./check-update.sh --install    add a */5 * * * * cron entry for this check
#   ./check-update.sh --uninstall  remove that cron entry
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_MARKER="# waycontext-update-check"
CRON_LINE="*/5 * * * * \"$SCRIPT_DIR/check-update.sh\" $CRON_MARKER"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

install_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    err "crontab not found. Install cron (e.g. 'sudo apt install cron') first."
    exit 1
  fi
  local current
  current="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$current" | grep -qF "$CRON_LINE"; then
    log "Cron entry already up to date, skipping."
  else
    # Drop any prior line carrying our marker (e.g. an older schedule) before
    # adding the current one, so re-running --install upgrades in place
    # instead of leaving a stale duplicate behind.
    local filtered
    filtered="$(printf '%s\n' "$current" | grep -vF "$CRON_MARKER" || true)"
    { printf '%s\n' "$filtered"; echo "$CRON_LINE"; } | grep -v '^$' | crontab -
    log "Installed/updated: runs every 5 minutes -> $SCRIPT_DIR/check-update.sh (notifies at most once/day)"
  fi
  log "Status (overwritten each run): ${XDG_CACHE_HOME:-$HOME/.cache}/waycontext/status"
  log "Log (only appended when it actually notifies): ${XDG_CACHE_HOME:-$HOME/.cache}/waycontext/update-check.log"
  log "Running an initial check now..."
  "$SCRIPT_DIR/check-update.sh"
  exit 0
}

uninstall_cron() {
  if ! command -v crontab >/dev/null 2>&1 || ! crontab -l >/dev/null 2>&1; then
    log "No crontab for this user, nothing to remove."
    exit 0
  fi
  crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" | crontab -
  log "Removed the update-check cron entry (if it was present)."
  exit 0
}

case "${1:-}" in
  --install) install_cron ;;
  --uninstall) uninstall_cron ;;
  "") ;;
  *) err "Unknown option: $1 (expected --install or --uninstall)"; exit 1 ;;
esac

cd "$SCRIPT_DIR"

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/waycontext"
LOG_FILE="$STATE_DIR/update-check.log"
STATUS_FILE="$STATE_DIR/status"
NOTIFIED_FILE="$STATE_DIR/last-notified-date"
mkdir -p "$STATE_DIR"

ts()    { date '+%Y-%m-%d %H:%M:%S'; }
today() { date '+%Y-%m-%d'; }

# Run by hand, this script used to print nothing at all -- every result went
# only to $STATUS_FILE -- which reads as "broken". A terminal run is someone
# asking "am I up to date?", so answer on stdout too. Cron's stdout is not a
# TTY, and cron mails whatever a job prints, so the 5-minute run stays silent.
INTERACTIVE=false
if [ -t 1 ]; then INTERACTIVE=true; fi

report() {
  echo "$(ts) $1" > "$STATUS_FILE"
  if [ "$INTERACTIVE" = true ]; then log "$1"; fi
}

# notify-send is Linux-only, so a Mac never showed anything. osascript gets the
# text as argv rather than spliced into the AppleScript source, so a quote in
# the path cannot break (or inject into) the script. Both are best-effort: from
# cron, either can lack access to the desktop session, and the log line in
# $LOG_FILE is the record that does not depend on one.
notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$1" "$2" || true
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e 'on run argv' \
      -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
      -e 'end run' "$1" "$2" >/dev/null 2>&1 || true
  fi
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  report "skip: $SCRIPT_DIR is not a git repository"
  exit 0
fi

if ! git rev-parse --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  report "skip: no upstream tracking branch"
  exit 0
fi

if ! FETCH_ERR="$(git fetch --quiet 2>&1)"; then
  report "skip: git fetch failed: ${FETCH_ERR:-unknown error} (offline?)"
  exit 0
fi

BEHIND="$(git rev-list --count HEAD..@{u})"

if [ "$BEHIND" -eq 0 ]; then
  report "up to date ($(git rev-parse --short HEAD))"
  exit 0
fi

MSG="waycontext: $BEHIND new commit(s) on origin — run ./update.sh in $SCRIPT_DIR"

# The status file keeps its short form; the terminal gets the actionable one.
echo "$(ts) behind by $BEHIND commit(s)" > "$STATUS_FILE"
if [ "$INTERACTIVE" = true ]; then log "$MSG"; fi

# The once-a-day debounce limits notifications and log lines only; a terminal
# run above has already answered regardless.
LAST_NOTIFIED="$(cat "$NOTIFIED_FILE" 2>/dev/null || true)"
if [ "$LAST_NOTIFIED" = "$(today)" ]; then
  exit 0 # already notified today — stay quiet until tomorrow
fi

echo "$(ts) $MSG" >> "$LOG_FILE"
today > "$NOTIFIED_FILE"
notify "waycontext update available" "$MSG"
