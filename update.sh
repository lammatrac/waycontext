#!/usr/bin/env bash
# Update an existing clone: pull the latest commits, then re-run install.sh so
# every config (npm deps, DB schema, waycontext CLI link, MCP registration) is
# refreshed to match. install.sh is idempotent and additive — it only fills in
# what's missing/stale, it never overwrites what you've customized (.env,
# ~/.claude/CLAUDE.md, unrelated hooks, etc.).
#
# The global CLAUDE.md section and the PreToolUse hook are NOT touched: both
# became opt-in (`waycontext init`, `waycontext hook install`), so nothing here
# reaches outside the repo except the MCP registration.
#
# This is the clone update path. For a global npm install, see the message below.
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

# This script ships inside the npm package too, where there is no git history to
# pull from. That isn't an error, it just means the update is npm's job -- saying
# "re-clone instead" to someone who installed with `npm install -g` sends them
# down the wrong path entirely.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "$SCRIPT_DIR isn't a git clone, so this looks like a global npm install."
  echo ""
  echo "Update it with:"
  echo "  npm install -g waycontext@latest"
  echo ""
  echo "Then apply any new migrations and restart your MCP client:"
  echo "  waycontext migrate"
  exit 0
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
