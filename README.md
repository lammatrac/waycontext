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

## Why an embedding provider?

Semantic search — the vector-ANN half of `search_code` and all of `find_related` — needs a numeric embedding for every indexed symbol. This server doesn't run a local embedding model, so it calls an external API to generate those vectors at index time (and for each query). `VOYAGE_API_KEY` / `OPENAI_API_KEY` in `.env` are what that call authenticates with:

- **Voyage AI** (`voyage-code-3`) — the recommended default. It's trained specifically on code, so it tends to place semantically similar functions closer together than a general-purpose text embedding model would.
- **OpenAI** (`text-embedding-3-small`) — a general-purpose alternative, useful if you already have OpenAI API access and would rather not manage a second provider's key.
- **`EMBEDDING_PROVIDER=none`** — skip embeddings entirely. `index_project`, the graph tools (`get_graph`, `get_callers`, `get_callees`, `get_file_outline`, `project_overview`), and the full-text half of `search_code` all work with no API key. You only lose the semantic/ANN component of `search_code` (matches found by meaning, not just shared words) and `find_related` returns nothing.

Either provider is a fine choice — pick whichever fits your budget or existing infra. Just make sure `EMBEDDING_DIM` matches the model you pick (see comments in `.env.example`); changing it later requires re-running `init-db` and reindexing.

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

### 3. CLI

Every MCP tool is also available as a CLI subcommand via `src/cli.js` — useful for a first index, or for querying the graph/search tools from a terminal without going through an MCP client.

```bash
node src/cli.js index_project <project-name> /path/to/project/
node src/cli.js stats
```

To call it as a plain `codecontext` command from anywhere, link the package once:

```bash
cd code-context-mcp
npm link
```

```bash
codecontext help
codecontext index_project <project-name> /path/to/project/
codecontext search_code <project-name> "purge cache after match update"
codecontext get_symbol <project-name> <name>
codecontext get_callers <project-name> <name>
codecontext get_graph <project-name> <name> [depth]
codecontext project_overview <project-name>
codecontext tables                        # list tables + approx row counts
codecontext tables symbols 50             # browse rows of one table (default limit 20)
codecontext db                             # interactive psql session against DATABASE_URL
```

`index` is kept as an alias for `index_project`, and `stats` prints `list_projects` as a table instead of JSON. `db` requires the `psql` client (`sudo apt install -y postgresql-client` if missing).

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

## Database schema

Everything is stored in 4 Postgres tables, one project's worth of code broken down into files → symbols → edges. Browse them directly with `codecontext tables` / `codecontext db` (see [CLI](#3-cli)).

```
projects ──< files ──< symbols ──< edges >── symbols
   (1)        (N)         (N)        (N)        (also N, self-referencing)
```

### `projects`

One row per indexed codebase (what you pass as `<project>` to every tool/CLI command).

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` (PK) | Internal numeric ID; other tables reference this, not the name. |
| `name` | `text` (unique) | The short project name you chose, e.g. `dating-local`. |
| `root_path` | `text` | Absolute path on disk that was indexed. Re-indexing the same `name` updates this if the path moved. |
| `indexed_at` | `timestamptz` | Timestamp of the last completed `index_project` run. |

### `files`

One row per source file that was scanned (after `.gitignore`/`node_modules`/etc. filtering).

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` (PK) | Internal ID; `symbols.file_id` points here. |
| `project_id` | `int` (FK → `projects.id`) | Which project this file belongs to. Deleting a project cascades and removes its files. |
| `path` | `text` | File path relative to `root_path` (not absolute), e.g. `inc/tracking/clickid.php`. Unique per project. |
| `language` | `text` | Detected language (`php`, `javascript`, `typescript`, `tsx`, …) from the file extension. |
| `hash` | `text` | SHA-256 of the file's content. Compared on the next `index_project` run to skip unchanged files — this is what makes indexing incremental. |
| `loc` | `int` | Line count. |
| `updated_at` | `timestamptz` | When this file row was last (re)written by the indexer. |

### `symbols`

One row per function, method, class, interface, or trait found inside a file — the unit everything else (search, graph, callers) is built on.

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` (PK) | Internal ID; referenced by `edges.src` / `edges.dst`. |
| `project_id` | `int` (FK → `projects.id`) | Which project this symbol belongs to. |
| `file_id` | `int` (FK → `files.id`) | Which file defines this symbol. |
| `name` | `text` | Symbol name. Methods are stored as `ClassName::methodName` so they stay unique and greppable across a whole class hierarchy. |
| `kind` | `text` | One of `function`, `method`, `class`, `interface`, `trait`. |
| `signature` | `text` | The declaration line (parameters, return type where the language has one). |
| `doc` | `text` | The docblock/leading comment directly above the symbol, if any. |
| `start_line` / `end_line` | `int` | Where the symbol's body starts/ends in the file — what `get_symbol` uses to show source, and what an editor jump-to-definition would use. |
| `body` | `text` | The symbol's source code, truncated to 6 KB (see [Notes & limits](#notes--limits)). |
| `embedding` | `vector(EMBEDDING_DIM)` | The symbol's semantic embedding (from Voyage/OpenAI), used by the vector half of `search_code` and by `find_related`. `NULL` when `EMBEDDING_PROVIDER=none`. |
| `fts_vector` | `tsvector` (generated) | Auto-computed full-text index over `name` (weight A) + `doc` (weight B) + `body` (weight C) — the full-text half of `search_code`. You never write this column directly; Postgres regenerates it whenever the row changes. |

Indexed on `(project_id, name)` for exact/fuzzy symbol lookups, on `file_id` for `get_file_outline`, on `embedding` (HNSW) for ANN search, and on `fts_vector` (GIN) for full-text search.

### `edges`

One row per relationship between two symbols (or a symbol and something unresolved) — this is the "relationship graph" the project description refers to. `get_graph`/`get_callers`/`get_callees` are just BFS/lookup queries over this table.

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` (PK) | Internal ID. |
| `project_id` | `int` (FK → `projects.id`) | Which project this edge belongs to. |
| `src` | `int` (FK → `symbols.id`) | The symbol where the reference originates (the caller, the subclass, the file registering a hook). |
| `dst` | `int` (FK → `symbols.id`, nullable) | The symbol being referenced, if it was resolved to a known symbol in the same project. |
| `dst_name` | `text` (nullable) | The raw callee/import/hook name as written in the source, used when `dst` couldn't be resolved (e.g. a dynamic call like `call_user_func($fn)`, or a symbol defined outside the indexed project). Still useful signal even unresolved. |
| `relation` | `text` | The kind of relationship — one of `CALLS`, `INSTANTIATES`, `EXTENDS`, `IMPLEMENTS`, `IMPORTS`, `REGISTERS_HOOK` (WordPress `add_action`/`add_filter`), `FIRES_HOOK` (WordPress `do_action`/`apply_filters`). |
| `file_id` | `int` (FK → `files.id`) | Which file the reference was found in (usually the same file as `src`, but not always, e.g. for cross-file hook registration). |
| `line` | `int` | Line number of the reference. |

Indexed on `src` and `dst` (traversal in either direction) and on `(project_id, relation)` (filtering by relationship type).

## How `search_code` works

`search_code` is a hybrid search: it always runs a Postgres full-text query, and — when an embedding provider is configured — also runs a pgvector nearest-neighbor query, then merges the two ranked lists with Reciprocal Rank Fusion (RRF).

1. **Full-text candidates** — every indexed symbol has a generated `fts_vector` column (`name` weighted highest, then `doc`, then `body`), so a query like `"purge cache after match update"` matches on literal words. This always runs, with no API key required.
2. **Vector candidates** (only if `EMBEDDING_PROVIDER` isn't `none`) — the query is embedded and compared against each symbol's stored embedding by cosine distance, surfacing matches by *meaning* even when the wording differs from the code (e.g. a query about "revoking a signing key" finding a function named `rotateSecretKey`).
3. **Fusion** — both ranked lists are combined via RRF: a symbol ranked highly in *both* lists outranks one that only appears in a single list. Each result includes a `score` (the fused RRF score, not a raw similarity) and `matched_via` (`["fts"]`, `["vector"]`, or `["fts","vector"]`) showing which signal(s) found it.

With `EMBEDDING_PROVIDER=none`, step 2 is skipped and results are full-text only — still better than a plain substring search, just without the semantic/meaning-based matches.

One current limitation: Postgres's full-text tokenizer splits on punctuation/whitespace, not on camelCase or snake_case boundaries, so `purgeCacheAfterMatchUpdate` is indexed as a single token rather than four separate words. Multi-word queries still find such symbols via the vector half (when embeddings are enabled) or by matching the `doc`/`body` text, just not by decomposing the identifier itself.

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

### 2026-07-21
- Added a `codecontext` CLI: `src/cli.js` now exposes every MCP tool (`search_code`, `get_symbol`, `get_callers`, `get_callees`, `get_graph`, `get_file_outline`, `find_related`, `project_overview`, `list_projects`) as a subcommand, in addition to the existing `index`/`stats`/`init-db`. Registered as a `bin` entry in `package.json`; run `npm link` to get a global `codecontext` command.
- Added `codecontext db` (interactive `psql` session against `DATABASE_URL`) and `codecontext tables [table] [limit]` (list tables with row counts, or browse a table's rows) for inspecting the Postgres schema directly from the terminal.
- Added a "Database schema" section documenting all 4 tables (`projects`, `files`, `symbols`, `edges`), every column's meaning, and how they relate, so the Postgres structure is understandable without reading `src/db.js`.

### 2026-07-18
- Fixed `Parse failed: ... (Invalid argument)` errors on larger source files: `parseFile` now passes an explicit `bufferSize` to tree-sitter's `parse()`, avoiding a chunked-read bug in the native binding that triggered once file content reached 32768 UTF-16 units.
- Added hybrid search (full-text + pgvector ANN, RRF-fused) to `search_code`.
- Documented why an embedding provider (Voyage/OpenAI) is needed and added a "How `search_code` works" section explaining the full-text/vector/RRF fusion.
