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
DB_PASS="codectx"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

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

# 2. PostgreSQL + pgvector (Ubuntu/Debian, best-effort; skipped if DB already reachable)
if command -v psql >/dev/null 2>&1 && PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c '\q' >/dev/null 2>&1; then
  log "PostgreSQL database '$DB_NAME' already reachable, skipping DB setup"
elif command -v apt >/dev/null 2>&1; then
  log "Setting up PostgreSQL + pgvector (requires sudo)..."
  sudo apt update
  sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"
else
  warn "No 'apt' found and '$DB_NAME' isn't reachable on localhost. Set up PostgreSQL + pgvector manually (see README), then re-run this script."
fi

# 3. Build tools for tree-sitter native bindings, then npm install
if command -v apt >/dev/null 2>&1 && ! dpkg -s build-essential >/dev/null 2>&1; then
  log "Installing build tools for tree-sitter native bindings (requires sudo)..."
  sudo apt install -y build-essential python3
fi

log "Installing npm dependencies..."
npm install

# 4. .env
if [ -f .env ]; then
  log ".env already exists, skipping"
else
  cp .env.example .env
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

# 8. Add the Code Context MCP Workflow section to the global CLAUDE.md, so
# every project's Claude Code session (not just this one) treats this MCP as
# the primary way to find code. Best-effort: a failure here shouldn't fail
# the whole install since the MCP server itself is already registered.
if node "$SCRIPT_DIR/src/cli.js" init-global; then
  :
else
  warn "Failed to update ~/.claude/CLAUDE.md — run manually: node $SCRIPT_DIR/src/cli.js init-global"
fi

log "Setup complete. Edit .env with your embedding API key if you haven't already, then restart Claude Code."
