#!/usr/bin/env bash
# Update an existing install: pull the latest commits for this repo, then
# re-run install.sh so every config (npm deps, DB schema, waycontext CLI
# link, MCP registration, global CLAUDE.md section, PreToolUse hook) is
# refreshed to match. install.sh is idempotent and additive — it only fills
# in what's missing/stale, it never overwrites what you've customized
# (.env, the rest of ~/.claude/CLAUDE.md, unrelated hooks, etc.).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

if ! command -v git >/dev/null 2>&1; then
  err "git not found. Install git first."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "$SCRIPT_DIR isn't a git repository — can't update in place. Re-clone instead."
  exit 1
fi

# Never discard local work: abort rather than stash/reset behind your back.
if [ -n "$(git status --porcelain)" ]; then
  err "You have uncommitted changes in $SCRIPT_DIR — commit or stash them first, then re-run:"
  echo "  cd $SCRIPT_DIR && git stash -u   # or: git commit -am 'wip'"
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! git rev-parse --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  warn "Branch '$BRANCH' has no upstream tracking branch — skipping fetch/pull, running install.sh as-is."
else
  log "Fetching latest commits..."
  git fetch

  BEHIND="$(git rev-list --count HEAD..@{u})"

  if [ "$BEHIND" -eq 0 ]; then
    log "Already up to date ($BRANCH @ $(git rev-parse --short HEAD))."
  else
    log "$BEHIND new commit(s) available:"
    git log --oneline "HEAD..@{u}"
    log "Pulling (fast-forward only)..."
    if ! git pull --ff-only; then
      err "Fast-forward pull failed — local and remote have diverged. Resolve manually (e.g. git rebase), then re-run this script."
      exit 1
    fi
  fi
fi

log "Re-running install.sh to refresh configs..."
exec "$SCRIPT_DIR/install.sh"
