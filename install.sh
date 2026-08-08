#!/usr/bin/env bash
# First-time setup for a fresh clone of this repo:
#   PostgreSQL + pgvector -> npm install -> .env -> init-db -> npm link -> register MCP with Claude Code (user scope)
# Safe to re-run (idempotent) after a `git pull`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MCP_NAME="waycontext"
DB_NAME="codectx"
DB_USER="codectx"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

# 1. Node.js
#
# Checked first, before anything else needs a working toolchain. This block used
# to sit below the password generation, which called `node` -- so on a machine
# without Node the script died at that line with bash's own "node: command not
# found" and this message, written for exactly that audience, never printed.
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node.js >= 18 first: https://nodejs.org/en/download"
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js >= 18 required, found $(node -v)."
  exit 1
fi
log "Node.js $(node -v) OK"

# Database password: reuse whatever .env already holds, so re-running this
# script never invalidates a working install. Only a genuinely fresh setup
# generates one -- the password used to be the literal string "codectx",
# committed in this file, which is a poor default even for a local database.
#
# The `[ -f .env ]` guard is load-bearing, not defensive. `sed` exits 2 when it
# cannot read its input; `2>/dev/null` hides the message but not the status,
# `set -o pipefail` then propagates it past `head`, and `set -e` aborts. So on a
# fresh clone -- the only case where there is no .env, and the only case this
# script is really for -- install.sh died on this line before doing anything.
# It went unnoticed because a re-run on a working install always has a .env.
DB_PASS=""
if [ -f .env ]; then
  DB_PASS="$(sed -n 's|^DATABASE_URL=postgres://[^:]*:\([^@]*\)@.*|\1|p' .env | head -1)"
fi
GENERATED_PASS=false
if [ -z "$DB_PASS" ]; then
  DB_PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')"
  GENERATED_PASS=true
fi

# 2. PostgreSQL + pgvector.
#
# Preference order: an already-reachable database, then Docker (works the same
# on every OS and needs no sudo), then apt (Ubuntu/Debian only). The apt path
# used to be the only option, which made setup impossible on macOS and on any
# non-Debian distro without following the manual instructions.
DB_PORT="5432"
if [ -f .env ]; then
  env_port="$(sed -n 's|^DATABASE_URL=postgres://[^@]*@[^:]*:\([0-9]*\)/.*|\1|p' .env | head -1)"
  [ -n "$env_port" ] && DB_PORT="$env_port"
fi

db_reachable() {
  command -v psql >/dev/null 2>&1 || return 1
  PGPASSWORD="$DB_PASS" psql -h localhost -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c '\q' >/dev/null 2>&1
}
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- 3>&- && return 0
  return 1
}
COMPOSE_FILE="$SCRIPT_DIR/docker/docker-compose.yml"

if db_reachable; then
  log "PostgreSQL database '$DB_NAME' already reachable on port $DB_PORT, skipping DB setup"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
     && docker compose version >/dev/null 2>&1; then
  # Something else already owns the default port -- pick the next free one and
  # let the generated DATABASE_URL point at it, rather than failing to bind.
  if port_in_use "$DB_PORT"; then
    for candidate in 5433 5434 5435 5436; do
      if ! port_in_use "$candidate"; then
        warn "Port $DB_PORT is already in use; using $candidate for WayContext's database"
        DB_PORT="$candidate"
        break
      fi
    done
  fi

  # Exported for EVERY compose invocation, not just `up`. The compose file
  # declares POSTGRES_PASSWORD as ${DB_PASS:?...}, so any command that has to
  # interpolate the service definition -- `ps`, `logs`, and the diagnostics
  # below -- fails with "DB_PASS must be set" without it. That is also why the
  # old failure message, which told you to run `docker compose ... logs`, did
  # not work when followed literally.
  export DB_USER DB_PASS DB_NAME DB_PORT

  # Dump the container's own account of itself. Reaching the timeout used to
  # print "check: docker compose logs" and exit, which meant the one run that
  # knew what went wrong -- often the only run, on a CI box that is then
  # destroyed -- threw that information away.
  db_diagnostics() {
    err "The database container never became healthy. Its own account:"
    docker compose -f "$COMPOSE_FILE" ps || true
    docker compose -f "$COMPOSE_FILE" logs --tail=60 postgres 2>&1 | sed 's/^/    /' || true
  }

  log "Starting PostgreSQL + pgvector via Docker on port $DB_PORT..."
  log "Waiting for the database to accept connections (first run pulls the image)..."

  # The compose file already defines a healthcheck, so let compose do the
  # waiting: --wait blocks until the service reports healthy and fails if it
  # never does. This replaces a hand-rolled 60x1s `exec pg_isready` loop that
  # could not tell "still initialising" from "crash-looping", and whose budget
  # a cold CI runner exhausted -- pulling a ~400 MB image and running initdb on
  # a slow disk is routinely more than a minute.
  if docker compose up --help 2>&1 | grep -q -- '--wait-timeout'; then
    if ! docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout 300; then
      db_diagnostics
      exit 1
    fi
  else
    # Older compose: no --wait. Poll the healthcheck ourselves, with a budget
    # that accounts for the image pull.
    docker compose -f "$COMPOSE_FILE" up -d
    ready=false
    for _ in $(seq 1 300); do
      if docker compose -f "$COMPOSE_FILE" exec -T postgres \
           pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 1
    done
    if [ "$ready" != true ]; then
      db_diagnostics
      exit 1
    fi
  fi
  log "Database ready"
elif command -v apt >/dev/null 2>&1; then
  log "Setting up PostgreSQL + pgvector (requires sudo)..."
  sudo apt update
  sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    # The role predates this run. If we just generated a password (no .env to
    # read it from) the stored one is unknown, so reset it to match.
    if [ "$GENERATED_PASS" = true ]; then
      sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';"
    fi
  else
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  fi
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"
else
  # Stopping here rather than falling through. Everything past this point
  # assumes a database: step 5 runs init-db, which would crash with a raw
  # connection error several steps after the real problem was already known.
  err "'$DB_NAME' isn't reachable, and neither Docker nor apt is available to provision it."
  echo "" >&2
  echo "Install Docker (the easiest path, no sudo needed):" >&2
  echo "  https://docs.docker.com/get-started/get-docker/" >&2
  echo "" >&2
  echo "or set up PostgreSQL + pgvector by hand -- see docs/installation.md -- and put" >&2
  echo "the connection string in .env as DATABASE_URL. Then re-run this script." >&2
  exit 1
fi

# 3. npm install
#
# The tree-sitter packages ship prebuilt N-API binaries (via prebuildify +
# node-gyp-build) for linux-x64, darwin-x64, darwin-arm64 and win32-x64, so
# npm install uses those and never invokes node-gyp there. This script used to
# apt-install build-essential and python3 unconditionally, which asked for
# sudo and several minutes for a toolchain that was then never used.
#
# Platforms without a prebuild -- notably linux-arm64, musl/Alpine and BSD --
# do fall back to compiling from source. Only offer the toolchain there, and
# only if it's actually missing.
needs_toolchain=false
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Darwin/*|MINGW*|MSYS*) ;;
  *) needs_toolchain=true ;;
esac
if [ -f /etc/alpine-release ]; then needs_toolchain=true; fi

if [ "$needs_toolchain" = true ] && ! command -v cc >/dev/null 2>&1; then
  warn "No prebuilt tree-sitter binary for $(uname -s)/$(uname -m) — it will be compiled from source."
  if command -v apt >/dev/null 2>&1; then
    log "Installing build tools (requires sudo)..."
    sudo apt install -y build-essential python3
  else
    warn "Install a C/C++ toolchain and python3 first if 'npm install' fails."
  fi
fi

log "Installing npm dependencies..."
npm install

# 4. .env
#
# The rewrite goes through a temp file rather than `sed -i`. GNU sed treats -i's
# argument as optional; BSD sed (macOS) requires one and reads the next argument
# as a backup suffix, so `sed -i "s|...|"` fails there -- and with `set -e` that
# aborted the whole install on the fresh-install path, which is precisely the one
# a first-time macOS user takes.
if [ -f .env ]; then
  log ".env already exists, skipping"
else
  cp .env.example .env
  DB_URL="postgres://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME"
  if grep -q '^DATABASE_URL=' .env; then
    tmp="$(mktemp)"
    sed "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env > "$tmp"
    mv "$tmp" .env
  else
    printf '\nDATABASE_URL=%s\n' "$DB_URL" >> .env
  fi
  chmod 600 .env   # it now holds a generated credential
  warn "Created .env from .env.example — edit it to add your VOYAGE_API_KEY or OPENAI_API_KEY"
fi

# 5. Database schema
log "Initializing database schema..."
npm run init-db

# 6. waycontext CLI (optional, non-fatal if it fails)
#
# The package was called code-context-mcp before v0.2.0. Its global link still
# owns the `codecontext` binary name, so leaving it in place would shadow the
# new one with whatever revision was linked then.
if npm ls -g --depth=0 code-context-mcp >/dev/null 2>&1; then
  log "Removing the pre-v0.2.0 'code-context-mcp' global link..."
  npm uninstall -g code-context-mcp >/dev/null 2>&1 || \
    warn "Could not remove the old link; run: npm uninstall -g code-context-mcp"
fi

if command -v waycontext >/dev/null 2>&1; then
  log "'waycontext' CLI already linked, skipping"
else
  log "Linking 'waycontext' CLI globally..."
  link_err="$(mktemp)"
  if ! npm link 2>"$link_err"; then
    warn "npm link failed (may need sudo). Run manually: cd $SCRIPT_DIR && npm link"
    cat "$link_err" >&2 || true
  fi
  rm -f "$link_err"
fi

# 7. Register the MCP server with Claude Code at user scope.
#
# A missing `claude` is not an install failure. WayContext speaks MCP over stdio
# to any client -- Cursor, Windsurf, Zed, a plain .mcp.json -- and by this point
# every step that actually matters has already succeeded. Exiting 1 here told
# those users their install had failed when it hadn't, and skipped the completion
# message and the optional next steps below.
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code CLI ('claude') not found in PATH — skipping automatic MCP registration."
  echo "" >&2
  echo "  For Claude Code, once it's installed:" >&2
  echo "    claude mcp add --scope user $MCP_NAME -- node $SCRIPT_DIR/src/server.js" >&2
  echo "" >&2
  echo "  For any other MCP client, add this to its config:" >&2
  echo "    {\"mcpServers\": {\"$MCP_NAME\": {\"command\": \"node\", \"args\": [\"$SCRIPT_DIR/src/server.js\"]}}}" >&2
  echo "" >&2
else
  mcp_err="$(mktemp)"
  if claude mcp add --scope user "$MCP_NAME" -- node "$SCRIPT_DIR/src/server.js" 2>"$mcp_err"; then
    log "Registered MCP server '$MCP_NAME' with Claude Code (user scope)"
  elif grep -qi "already exists" "$mcp_err"; then
    warn "MCP '$MCP_NAME' is already registered at user scope, skipping"
  else
    err "Failed to register MCP server:"
    cat "$mcp_err" >&2
    rm -f "$mcp_err"
    exit 1
  fi
  rm -f "$mcp_err"
fi

# 8. Nothing outside this repo and the MCP registration is touched, except a
# tab-completion script the user already installed, which is refreshed in
# place (see step 9).
#
# Earlier versions also rewrote ~/.claude/CLAUDE.md and installed a PreToolUse
# hook that DENIED grep in every indexed project, machine-wide and unattended.
# That degraded unrelated projects on the same machine and blocked legitimate
# greps of docs and config. Both are now opt-in, per project, and advisory by
# default. If you had the old setup, `waycontext uninstall` removes it.

# 9. Tab completion: refresh it if the user opted in, never create it unattended.
# Opting in once keeps it current across upgrades (update.sh re-runs this file);
# opting out stays opted out.
COMPLETION_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/waycontext"
if [ -f "$COMPLETION_FILE" ]; then
  if node "$SCRIPT_DIR/src/cli.js" completion install >/dev/null 2>&1; then
    log "Refreshed tab completion (already installed)"
  else
    warn "Could not refresh tab completion; run: waycontext completion install"
  fi
fi

# 10. Start the managed local HTTP service (idempotent, no duplicate processes).
# This is best-effort: a machine with no reachable DB should still finish install.
if node "$SCRIPT_DIR/src/cli.js" service ensure --quiet >/dev/null 2>&1; then
  log "WayContext background service is running"
else
  warn "Could not auto-start the WayContext background service. You can diagnose with: waycontext service status"
fi

log "Setup complete. Edit .env with your embedding API key if you haven't already, then restart Claude Code."
log ""
log "Recommended, per project:"
log "  waycontext init          point this repo's agents at WayContext"
log "                           (CLAUDE.md, AGENTS.md, copilot-instructions,"
log "                            and .vscode/mcp.json — this step registers the"
log "                            server with Copilot; the above only did Claude Code)"
log ""
log "Optional, per project:"
log "  waycontext hook install  block or flag greps in an indexed project"
log "  waycontext completion install  tab-complete subcommands and project names"
