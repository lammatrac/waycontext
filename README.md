# code-context-mcp

MCP server that scans and indexes an entire codebase — not just listing symbols, but building a **relationship graph** (calls, imports, inheritance, WordPress hooks) plus **vector embeddings** in PostgreSQL/pgvector — so AI agents get comprehensive project context.

## Architecture

```
┌─────────────┐   tree-sitter    ┌──────────────────────────────┐
│ Project dir │ ───────────────▶ │ symbols (fn/class/method)    │
│ (.php .js   │   AST walk       │ edges   (CALLS/IMPORTS/      │
│  .ts .tsx)  │                  │          EXTENDS/HOOKS…)     │
└─────────────┘                  │ embeddings (pgvector, HNSW)  │
                                 └───────────────┬──────────────┘
                                                 │ SQL + ANN
                                 ┌───────────────▼──────────────┐
                                 │ MCP tools over stdio          │
                                 │ search_code · get_graph ·     │
                                 │ get_callers · overview …      │
                                 └──────────────────────────────┘
```

- **Languages:** PHP, JavaScript, TypeScript, JSX/TSX (extendable in `src/parser.js`)
- **Graph relations:** `CALLS`, `INSTANTIATES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `REGISTERS_HOOK`, `FIRES_HOOK` (WordPress `add_action`/`do_action`/`apply_filters` aware)
- **Incremental indexing:** SHA-256 per file; unchanged files are skipped, deleted files are pruned
- **Embeddings:** Voyage (`voyage-code-3`, recommended for code) or OpenAI, or `none` (graph + keyword search still work)

## Setup on Ubuntu

### 1. PostgreSQL + pgvector

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
# On older Ubuntu, build pgvector from source:
#   sudo apt install -y postgresql-server-dev-16 build-essential git
#   git clone https://github.com/pgvector/pgvector && cd pgvector && make && sudo make install

sudo -u postgres psql -c "CREATE USER codectx WITH PASSWORD 'codectx';"
sudo -u postgres psql -c "CREATE DATABASE codectx OWNER codectx;"
sudo -u postgres psql -d codectx -c "CREATE EXTENSION vector;"
```

If you run Postgres in Docker instead, use the `pgvector/pgvector:pg16` image.

### 2. Install & init

```bash
# tree-sitter grammars compile native bindings:
sudo apt install -y build-essential python3

cd code-context-mcp
npm install
cp .env.example .env    # fill in DATABASE_URL + embedding API key
npm run init-db
```

### 3. First index (CLI)

```bash
node src/cli.js index <index-name> /path/to/project/
node src/cli.js stats
```

### 4. Register with Claude Code

```bash
claude mcp add code-context -- node /absolute/path/to/code-context-mcp/src/server.js
```

Or in `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "code-context": {
      "command": "node",
      "args": ["/absolute/path/to/code-context-mcp/src/server.js"]
    }
  }
}
```

(Registration options: https://docs.claude.com/en/docs/claude-code/mcp)

## MCP tools

| Tool | Purpose |
|---|---|
| `index_project` | Scan + (re)index a directory. Incremental. |
| `list_projects` | Indexed projects with counts. |
| `project_overview` | Languages, dir sizes, hub symbols, WP hooks — the "big picture" call. |
| `search_code` | Hybrid search (full-text + semantic ANN, RRF-fused): "purge cache after cron match update" → relevant functions. |
| `get_symbol` | Full detail of a function/class/method (accepts `Class::method`). |
| `get_callers` | Inbound edges — blast radius before refactoring. |
| `get_callees` | Outbound dependencies incl. hooks registered/fired. |
| `get_graph` | BFS subgraph around a symbol (depth 1–4) — feature wiring map. |
| `get_file_outline` | All symbols in one file. |
| `find_related` | Semantically similar symbols — discover a feature's full surface. |

## Suggested agent workflow (e.g. in CLAUDE.md)

```
Before modifying code:
1. project_overview → orient
2. search_code with the task description → candidate symbols
3. get_graph / get_callers on the target → impact analysis
4. get_symbol → read actual source
Re-run index_project after committing changes.
```

## Extending

- **More languages:** add a tree-sitter grammar package, map extensions in `EXT_LANG`, add node types in `parser.js`.
- **File watcher:** wrap `indexProject` with `chokidar` for auto reindex on save.
- **Feature clustering:** k-means over the embedding column (`symbols.embedding`) to auto-name feature groups.

## Notes & limits

- Call resolution is name-based (exact + `Class::method` suffix), not type-inferred — dynamic calls (`$fn()`, `call_user_func`) stay as unresolved `dst_name` edges, which is still useful signal.
- Symbol bodies are truncated at 6 KB for storage/embedding.
- Files > 1 MB skipped (configurable via `MAX_FILE_SIZE`).

## Changes

### 2026-07-18
- Fixed `Parse failed: ... (Invalid argument)` errors on larger source files: `parseFile` now passes an explicit `bufferSize` to tree-sitter's `parse()`, avoiding a chunked-read bug in the native binding that triggered once file content reached 32768 UTF-16 units.
