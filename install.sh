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

# Database password: reuse whatever .env already holds, so re-running this
# script never invalidates a working install. Only a genuinely fresh setup
# generates one -- the password used to be the literal string "codectx",
# committed in this file, which is a poor default even for a local database.
DB_PASS="$(sed -n 's|^DATABASE_URL=postgres://[^:]*:\([^@]*\)@.*|\1|p' .env 2>/dev/null | head -1)"
GENERATED_PASS=false
if [ -z "$DB_PASS" ]; then
  DB_PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')"
  GENERATED_PASS=true
fi

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node.js >= 18 first."
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js >= 18 required, found $(node -v)."
  exit 1
fi
log "Node.js $(node -v) OK"

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

  log "Starting PostgreSQL + pgvector via Docker on port $DB_PORT..."
  DB_USER="$DB_USER" DB_PASS="$DB_PASS" DB_NAME="$DB_NAME" DB_PORT="$DB_PORT" \
    docker compose -f "$COMPOSE_FILE" up -d

  log "Waiting for the database to accept connections..."
  ready=false
  for _ in $(seq 1 60); do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres \
         pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [ "$ready" = true ]; then
    log "Database ready"
  else
    err "Database did not become ready in 60s. Check: docker compose -f $COMPOSE_FILE logs"
    exit 1
  fi
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
  warn "'$DB_NAME' isn't reachable and neither Docker nor apt is available."
  warn "Install Docker, or set up PostgreSQL + pgvector manually (see README), then re-run this script."
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
if [ -f .env ]; then
  log ".env already exists, skipping"
else
  cp .env.example .env
  DB_URL="postgres://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME"
  if grep -q '^DATABASE_URL=' .env; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env
  else
    printf '\nDATABASE_URL=%s\n' "$DB_URL" >> .env
  fi
  chmod 600 .env   # it now holds a generated credential
  warn "Created .env from .env.example — edit it to add your VOYAGE_API_KEY or OPENAI_API_KEY"
fi

# 5. Database schema
log "Initializing database schema..."
npm run init-db

# 6. codecontext CLI (optional, non-fatal if it fails)
if command -v codecontext >/dev/null 2>&1; then
  log "'codecontext' CLI already linked, skipping"
else
  log "Linking 'codecontext' CLI globally..."
  if ! npm link 2>/tmp/waycontext-npm-link-err.log; then
    warn "npm link failed (may need sudo). Run manually: cd $SCRIPT_DIR && npm link"
    cat /tmp/waycontext-npm-link-err.log >&2 || true
  fi
fi

# 7. Register the MCP server with Claude Code at user scope
if ! command -v claude >/dev/null 2>&1; then
  err "Claude Code CLI ('claude') not found in PATH. Install it, then run:"
  echo "  claude mcp add --scope user $MCP_NAME -- node $SCRIPT_DIR/src/server.js"
  exit 1
fi

if claude mcp add --scope user "$MCP_NAME" -- node "$SCRIPT_DIR/src/server.js" 2>/tmp/waycontext-mcp-add-err.log; then
  log "Registered MCP server '$MCP_NAME' with Claude Code (user scope)"
elif grep -qi "already exists" /tmp/waycontext-mcp-add-err.log; then
  warn "MCP '$MCP_NAME' is already registered at user scope, skipping"
else
  err "Failed to register MCP server:"
  cat /tmp/waycontext-mcp-add-err.log >&2
  exit 1
fi

# 8. Nothing outside this repo and the MCP registration is touched.
#
# Earlier versions also rewrote ~/.claude/CLAUDE.md and installed a PreToolUse
# hook that DENIED grep in every indexed project, machine-wide and unattended.
# That degraded unrelated projects on the same machine and blocked legitimate
# greps of docs and config. Both are now opt-in, per project, and advisory by
# default. If you had the old setup, `codecontext uninstall` removes it.

log "Setup complete. Edit .env with your embedding API key if you haven't already, then restart Claude Code."
log ""
log "Optional, per project:"
log "  codecontext init          document the project name in ./CLAUDE.md"
log "  codecontext hook install  nudge agents toward WayContext instead of grep"
