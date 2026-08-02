# WayContext

MCP server that scans and indexes an entire codebase — not just listing symbols, but building a **relationship graph** (calls, imports, inheritance, WordPress hooks) plus **vector embeddings** in PostgreSQL/pgvector — so AI agents get comprehensive project context.

## Setup

### From npm

```bash
npm install -g waycontext            # or run one-off with: npx waycontext <command>
waycontext migrate                   # create the schema
waycontext index_project myapp /path/to/myapp
```

This needs a PostgreSQL with pgvector — see [1. PostgreSQL + pgvector](#1-postgresql--pgvector) for a one-line Docker option. Point WayContext at it either through the environment or `~/.config/waycontext/config.json`:

```json
{
  "DATABASE_URL": "postgres://codectx:your-password@localhost:5432/codectx",
  "EMBEDDING_PROVIDER": "voyage",
  "VOYAGE_API_KEY": "..."
}
```

Then register the MCP server with your client:

```bash
claude mcp add --scope user waycontext -- waycontext-mcp
```

### From a clone

`install.sh` wires up everything — database, dependencies, schema, CLI link and MCP registration — in one step.

For a fresh clone, `install.sh` automates everything below: installs PostgreSQL + pgvector if not already present, runs `npm install`, copies `.env.example` to `.env` (if missing), initializes the database schema, links the `waycontext` CLI, and registers the MCP server with Claude Code at **user scope** (`claude mcp add --scope user waycontext`, available in every project, not just this one). It writes nothing else into `~/.claude` — the search hook and the per-project `CLAUDE.md` section are opt-in (`waycontext hook install`, `waycontext init`).

```bash
./install.sh
```

It's idempotent — safe to re-run after a `git pull`. Afterwards, edit `.env` to add your `VOYAGE_API_KEY`/`OPENAI_API_KEY`, then restart Claude Code. The steps below explain what it automates, for manual setup, non-Ubuntu systems, or troubleshooting.

### Updating an existing install

```bash
./update.sh      # or: npm run update
```

Pulls the latest commits (fast-forward only — aborts instead of merging/rebasing if your local history has diverged, and aborts instead of stashing/discarding if you have uncommitted changes) and then re-runs `install.sh`, so every config — npm deps, DB schema, the `waycontext` CLI link, MCP registration — is refreshed to match. Additive only: it never overwrites what you've customized (`.env`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, etc.). Since the search hook became opt-in, `install.sh` no longer writes anything into `~/.claude` at all — only the `claude mcp add --scope user` registration.

**Restart your MCP client after updating.** `update.sh` applies pending migrations to the database, but an MCP server process that was already running keeps the old code loaded. Most migrations are additive and a stale process is harmless, but a schema change that removes something it depends on isn't: the `0002_orgs` migration replaces the global unique constraint on `projects.name` with a per-org one, so a server started before it will fail `index_project` with `there is no unique or exclusion constraint matching the ON CONFLICT specification` until it's restarted. The CLI is unaffected — it's a fresh process each time.

To get notified instead of checking by hand, `check-update.sh` adds a cron entry that fetches from origin (read-only — it never pulls or runs `install.sh` itself):

```bash
./check-update.sh --install     # runs every 5 min via cron, notifies at most once/day
./check-update.sh --uninstall   # removes that cron entry
./check-update.sh                # run the check once, by hand
```

It runs every 5 minutes rather than at a fixed time of day — a personal laptop isn't guaranteed to be on at any particular hour, so a fixed daily slot could easily be missed entirely. Each run is just a cheap fetch + compare; if you're behind, it's debounced to notify **at most once per calendar day** (tracked in `~/.cache/waycontext/last-notified-date`) so it doesn't spam a notification (or a growing log) every 5 minutes. Current status is overwritten each run at `~/.cache/waycontext/status`; `~/.cache/waycontext/update-check.log` only gets a new line on the (at most one per day) run that actually notifies. It also fires a desktop notification via `notify-send` when available. `--install`/`--uninstall` only touch a single marker-tagged line in your crontab (and upgrade it in place if the schedule changes), leaving any other cron entries untouched.

### 1. PostgreSQL + pgvector

> **Configuration sources.** Settings are read, highest precedence first, from: the environment, `./.env` in the directory you run from, `.env` next to the install, `~/.config/waycontext/config.json` (override the path with `$WAYCONTEXT_CONFIG`), then built-in defaults. Set `WAYCONTEXT_IGNORE_DOTENV=1` to skip the `.env` files and configure purely from the environment.
>
> **No compiler needed.** The tree-sitter packages ship prebuilt binaries for linux-x64, darwin-x64, darwin-arm64 and win32-x64. Only platforms without a prebuild — linux-arm64, musl/Alpine, BSD — compile from source and need `build-essential` + `python3`; `install.sh` offers those there and nowhere else.

`install.sh` handles this for you, preferring — in order — a database that's already reachable, Docker, then apt. The two paths are below if you'd rather do it by hand.

**Docker (any OS, no sudo).** This is what `install.sh` uses when Docker is available:

```bash
DB_PASS=your-password docker compose -f docker/docker-compose.yml up -d
```

The `pgvector/pgvector:pg16` image already contains the extension, so nothing is compiled. Data lives in the named volume `waycontext-pgdata`: `down` keeps your index, `down -v` discards it. `DB_PASS` is required — the compose file refuses to start with a default password. Override `DB_PORT` if 5432 is taken; `install.sh` detects that case and picks the next free port automatically, writing the right port into `.env`.

**apt (Ubuntu/Debian).**

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
# On older Ubuntu, build pgvector from source:
#   sudo apt install -y postgresql-server-dev-16 build-essential git
#   git clone https://github.com/pgvector/pgvector && cd pgvector && make && sudo make install

sudo -u postgres psql -c "CREATE USER codectx WITH PASSWORD 'choose-a-password';"
sudo -u postgres psql -c "CREATE DATABASE codectx OWNER codectx;"
sudo -u postgres psql -d codectx -c "CREATE EXTENSION vector;"
```

Then put the matching `DATABASE_URL` in `.env`.

### 2. Install & init

```bash
cd waycontext
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

To call it as a plain `waycontext` command from anywhere, link the package once:

```bash
cd waycontext
npm link
```

```bash
waycontext help
waycontext init                           interactively write/update the CLAUDE.md WayContext section
waycontext hook install                   opt-in PreToolUse nudge (--global, --mode advise|ask|deny)
waycontext hook uninstall                 remove that hook
waycontext uninstall                      undo everything written outside this repo
waycontext migrate                        apply pending SQL migrations
waycontext migrate --status               show each migration's state without applying anything
waycontext index_project <project-name> /path/to/project/
waycontext search_code <project-name> "purge cache after match update"
waycontext get_symbol <project-name> <name>
waycontext get_callers <project-name> <name>
waycontext get_graph <project-name> <name> [depth]
waycontext project_overview <project-name>
waycontext tables                        # list tables + approx row counts
waycontext tables symbols 50             # browse rows of one table (default limit 20)
waycontext db                             # interactive psql session against DATABASE_URL
waycontext usage                          # embedding token usage, all projects
waycontext usage <project-name>           # embedding token usage, one project
```

`index`/`reindex` are kept as aliases for `index_project`, and `stats` prints `list_projects` as a table instead of JSON. `db` requires the `psql` client (`sudo apt install -y postgresql-client` if missing). `init` prompts for a project name and writes (or updates) a `## WayContext` section in `./CLAUDE.md`, so an agent reading that file knows which project name to pass to the tools above — it asks for y/N confirmation before overwriting an existing section. `hook install` is the optional, stronger nudge — see [5. Optional: nudge agents toward the MCP](#5-optional-nudge-agents-toward-the-mcp) below.

Every DB/network-backed subcommand shows a spinner with a live elapsed-time counter (e.g. `⠹ Searching "purge cache"… 0.8s`) while it runs, then a final `✔ label (Xs)` line — so a slow embedding-API call or a big-table scan doesn't look hung. It only starts animating after ~150ms (fast queries just print the final line, no flicker), and it's written to **stderr**, so stdout stays clean JSON for piping (`waycontext search_code proj query 2>/dev/null | jq`). In a non-TTY context (CI, redirected output) it skips the animation and prints just the final line. `index_project` runs the same spinner for its whole duration, pausing it around its own per-step `console.log` progress lines (`Found N source files`, `Resolving graph edges…`, …) so the two don't collide — this keeps the animation visible during the otherwise-silent file-by-file processing in between.

### 4. Register with Claude Code

`install.sh` does this automatically at **user scope** (available in every project):

```bash
claude mcp add --scope user waycontext -- node /absolute/path/to/waycontext/src/server.js
```

Or at project scope only:

```bash
claude mcp add waycontext -- node /absolute/path/to/waycontext/src/server.js
```

Or in `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "waycontext": {
      "command": "node",
      "args": ["/absolute/path/to/waycontext/src/server.js"]
    }
  }
}
```

(Registration options: https://docs.claude.com/en/docs/claude-code/mcp)

### 5. Optional: nudge agents toward the MCP

Registering the MCP server (step 4) makes its tools *available* in every project. `waycontext init` (step 3) tells the agent in *this* project which project name to pass. If you want a stronger push, there's an opt-in `PreToolUse` hook:

```bash
waycontext hook install                 # this project, advisory
waycontext hook install --mode ask      # prompt before each grep
waycontext hook install --mode deny     # block grep outright
waycontext hook install --global        # every project on this machine
waycontext hook uninstall
waycontext hook refresh                 # rebuild the project cache
```

When Claude Code is about to run a `Grep`-tool call or a `grep`/`egrep`/`fgrep`/`rg`/`ag` Bash command inside an indexed project, the hook fires. In the default **`advise`** mode the command still runs — the agent just gets a note alongside the result saying WayContext's search tools are available and usually better for code questions. `ask` turns it into a permission prompt; `deny` blocks the call and redirects. A trailing `# codectx-skip` comment bypasses any mode once.

Project roots come from a small JSON cache (`~/.cache/waycontext/projects.json`), refreshed by `hook install` and after every `index_project` — so the hook never touches the database and adds no latency to the agent's hot path. Because it's rewritten from whichever database that index run used, pointing the CLI at a different `DATABASE_URL` leaves the cache describing that one; `waycontext hook refresh` rebuilds it from your configured database without reindexing anything. Anything unexpected (no cache, cwd not indexed, `jq` missing) exits silently and leaves the tool call alone. When roots are nested, the deepest match wins. Installing is idempotent and leaves other hooks in the settings file untouched.

**Changed in a recent version:** this hook used to be installed globally and unattended by `install.sh`, in `deny` mode, alongside a `## WayContext Workflow` section written into `~/.claude/CLAUDE.md`. That degraded every project on the machine — including ones with nothing to do with WayContext — and blocked legitimate greps of docs, config, and logs. Both are now opt-in. To clean up a machine set up the old way:

```bash
waycontext uninstall
```

It removes the hook (project and global), the global CLAUDE.md section, and the cache, leaving your own content and any unrelated hooks intact. It prints — but does not run — the commands to unregister the MCP server, unlink the CLI, and drop the database.

## Architecture

![Architecture](src/images/architecture.png)

- **One operation registry:** every capability is declared once in `src/operations.js` — name, description, zod input schema, handler, and how it maps onto a CLI invocation. `src/server.js` loops over that list to register MCP tools and `src/cli.js` loops over it to dispatch subcommands, so the two surfaces cannot drift apart on argument names, defaults, or valid ranges, and `waycontext help` is generated rather than hand-maintained. Adding a capability means adding one entry.
- **Languages:** PHP, JavaScript, TypeScript, JSX/TSX (extendable in `src/parser.js`)
- **Graph relations:** `CALLS`, `INSTANTIATES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `REGISTERS_HOOK`, `FIRES_HOOK` (WordPress `add_action`/`do_action`/`apply_filters` aware)
- **Incremental indexing:** SHA-256 per file; unchanged files are skipped, deleted files are pruned. When a project's root is inside a git repo and it's been indexed before, re-runs scope file discovery to `git diff` since the last indexed commit instead of a full filesystem scan
- **Embeddings:** Voyage (`voyage-code-3`, recommended for code) or OpenAI, or `none` (graph + keyword search still work)

New to terms like AST, BFS, HNSW, cosine distance, or RRF? See [Algorithms & concepts explained](#algorithms--concepts-explained) below.

## Algorithms & concepts explained

The terms above (and elsewhere in this README) explained for anyone who hasn't worked with them before.

### AST parsing (tree-sitter)

An **AST** (Abstract Syntax Tree) is a tree-shaped representation of source code — each node is a language construct (a function, a call, an argument), not just raw text. `src/parser.js` has tree-sitter parse each file into this tree, then walks every node to pull out symbols (`function_definition`, `class_declaration`, …) and relationships (`call_expression`, `class_heritage`, …).

```php
function purgeCache() {
    invalidate($key);
}
```

```mermaid
graph TD
  F["function_definition<br/>name: purgeCache"] --> P["parameters: none"]
  F --> B["body"]
  B --> C["call_expression<br/>callee: invalidate"]
  C --> A["argument: $key"]
```

The indexer turns the `function_definition` node into a `symbols` row, and the `call_expression` node into a `CALLS` edge from `purgeCache` to `invalidate`.

### Incremental hashing (SHA-256)

Re-parsing every file on every run would be slow, so each file's content is hashed with **SHA-256** (a one-way fingerprint where any content change — even one character — produces a completely different hash) and compared against the hash stored from the last run.

```mermaid
flowchart LR
  A["Read file content"] --> B["SHA-256(content)"]
  B --> C{"Matches stored hash?"}
  C -- yes --> D["Skip file — unchanged"]
  C -- no --> E["Re-parse, re-embed,<br/>update symbols/edges"]
  E --> F["Store new hash"]
```

### BFS graph traversal (`get_graph`)

`get_graph` explores the `edges` table with a **breadth-first search (BFS)**: from the starting symbol it visits every direct neighbor first (depth 1, both callers and callees), then every neighbor-of-a-neighbor (depth 2), and so on up to the requested `depth`. This differs from a depth-first search, which would follow one chain as far as possible before backtracking — BFS instead guarantees everything within N hops is found before anything further away.

```mermaid
graph LR
  D2A["caller's caller"] --> D1A["caller"]
  D1A --> T(("target symbol"))
  T --> D1B["callee"]
  D1B --> D2B["callee's callee"]
```

Each ring above is one BFS layer — `depth=1` returns just the inner ring, `depth=2` adds the outer ring, and so on (capped at 60 nodes total, so a very hub-like symbol doesn't pull in the whole codebase).

### Vector embeddings & cosine distance

An **embedding** is a list of ~1000 numbers (a vector) representing what a piece of code *means*, produced by an embedding model (Voyage/OpenAI). Two symbols that do similar things end up with vectors pointing in a similar direction — measured as **cosine distance**: how large the angle between two vectors is, ignoring their length.

![Vector embeddings & cosine distance](src/images/vector-embeddings-cosine-distance.png)

Small angle (θ ≈ 0°) → cosine distance ≈ 0 → very similar meaning, even with completely different names or wording. Large angle (θ ≈ 90°+) → cosine distance ≈ 1+ → unrelated. `search_code`'s vector half and all of `find_related` rank symbols by this distance (Postgres's `<=>` operator, using pgvector's `vector_cosine_ops`).

### HNSW — the approximate nearest-neighbor index

Comparing a query's embedding against every single stored embedding one by one would be too slow at scale. Postgres instead uses an **HNSW** (Hierarchical Navigable Small World) index: a multi-layer graph where the top layer has a few nodes with long "highway" connections, and each layer below is denser, until the bottom layer connects every vector to its close neighbors.

![Hierarchical Navigable Small World](src/images/hierarchical-navigable-small-world.png)

A search starts at the top layer's entry point, greedily hops to whichever neighbor is closest to the query, and drops down a layer whenever no closer neighbor exists at the current one — arriving at a very good (not always perfect, hence "approximate") set of nearest neighbors in roughly log-time instead of scanning every row.

### Weighted full-text search (`tsvector`)

Postgres full-text search doesn't just check whether a word appears — `symbols.fts_vector` is built with `setweight()` so a match in the symbol's `name` (weight `A`) counts for more than a match in its `doc` comment (weight `B`), which counts for more than a match somewhere in the `body` (weight `C`). `ts_rank()` uses these weights, so a query like `"purge cache"` ranks a function literally named `purgeCache` above one that merely mentions "purge" once in a comment.

### Reciprocal Rank Fusion (RRF)

`search_code` gets two independently-ranked lists — full-text matches and vector/semantic matches — and needs to merge them into one ranking without either signal's raw scores (which aren't on comparable scales) dominating the other. **RRF** solves this using only each result's *position* in its list:

```
score(symbol) = Σ 1 / (k + rank_in_list)     (k = 60; summed over every list the symbol appears in)
```

| Symbol | Full-text rank | Vector rank | RRF score | Why |
|---|---|---|---|---|
| `purgeCacheAfterMatch` | 1 | 3 | 1/61 + 1/63 ≈ 0.0323 | found by both signals |
| `invalidateMatchCache` | — | 1 | 1/61 ≈ 0.0164 | vector-only, but ranked #1 there |
| `clearAllCaches` | 2 | — | 1/62 ≈ 0.0161 | full-text-only |

A symbol found by *both* searches — even at a middling rank in each — usually outranks one that only appears in a single list; that's the point of fusing two different signals instead of picking one. Each `search_code` result's `matched_via` field tells you which list(s) actually found it.

## Why an embedding provider?

Semantic search — the vector-ANN half of `search_code` and all of `find_related` — needs a numeric embedding for every indexed symbol. This server doesn't run a local embedding model, so it calls an external API to generate those vectors at index time (and for each query). `VOYAGE_API_KEY` / `OPENAI_API_KEY` in `.env` are what that call authenticates with:

- **Voyage AI** (`voyage-code-3`) — the recommended default. It's trained specifically on code, so it tends to place semantically similar functions closer together than a general-purpose text embedding model would.
- **OpenAI** (`text-embedding-3-small`) — a general-purpose alternative, useful if you already have OpenAI API access and would rather not manage a second provider's key.
- **`EMBEDDING_PROVIDER=none`** — skip embeddings entirely. `index_project`, the graph tools (`get_graph`, `get_callers`, `get_callees`, `get_file_outline`, `project_overview`), and the full-text half of `search_code` all work with no API key. You only lose the semantic/ANN component of `search_code` (matches found by meaning, not just shared words) and `find_related` returns nothing.

Either provider is a fine choice — pick whichever fits your budget or existing infra. Just make sure `EMBEDDING_DIM` matches the model you pick (see comments in `.env.example`); changing it later requires re-running `init-db` and reindexing.

### Tracking token usage & cost

Every embedding API call (indexing documents, or embedding a `search_code` query) logs its `provider`, `model`, `input_type`, and the token count the API reported into the `embedding_usage` table — see [Database schema](#database-schema). View it with:

```bash
waycontext usage                 # all projects, grouped by provider/model/input_type
waycontext usage <project-name>  # scoped to one project
```

Estimated cost is only shown if you set `VOYAGE_PRICE_PER_1M_TOKENS` / `OPENAI_PRICE_PER_1M_TOKENS` (USD per 1M tokens) in `.env` — this isn't hardcoded in the source since provider pricing changes over time; check the provider's current pricing page and set the rate yourself. Without it, `usage` still shows exact token counts, just no `est_cost_usd` column value.

Reference pricing, fetched directly from each provider's own docs on 2026-07-21 (verify against the live pages below before relying on this for budgeting — rates change):

| Provider | Model | Price (USD / 1M tokens) | Source |
|---|---|---|---|
| Voyage AI | `voyage-code-3` (this project's default) | $0.18 | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) |
| Voyage AI | `voyage-4` | $0.06 | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) |
| Voyage AI | `voyage-4-large` | $0.12 | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) |
| Voyage AI | `voyage-4-lite` | $0.02 | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) |
| OpenAI | `text-embedding-3-small` (this project's default) | $0.02 standard / $0.01 batch | [developers.openai.com/api/docs/models/text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small) |

`VOYAGE_PRICE_PER_1M_TOKENS=0.18` and `OPENAI_PRICE_PER_1M_TOKENS=0.02` (the standard, non-batch rate) are already set in `.env` to match this project's configured models (`VOYAGE_MODEL`/`OPENAI_EMBEDDING_MODEL`) — update them if you switch models or a provider changes pricing.

Usage tracking only covers calls made after upgrading to this version — run `waycontext init-db` once to create the `embedding_usage` table if it doesn't exist yet.

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

Everything is stored in 4 Postgres tables, one project's worth of code broken down into files → symbols → edges. Browse them directly with `waycontext tables` / `waycontext db` (see [CLI](#3-cli)).

The schema is defined by numbered SQL files in `src/migrations/`, applied in order and recorded once each in a `schema_migrations` ledger. `init-db` and `migrate` are the same operation; the MCP server also runs it at startup, so an install is never left on an older schema. A session-level advisory lock serializes concurrent runners, each file runs in its own transaction, and `${EMBEDDING_DIM}` is substituted from your `.env` before execution. Migrations are forward-only — there are no down migrations. `0001_baseline.sql` is the schema as it existed before the runner and is written entirely with `IF NOT EXISTS`, so it applies as a no-op to databases created by earlier versions; nothing needs to be dumped or recreated when upgrading.

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
| `last_indexed_sha` | `text` (nullable) | Git commit SHA this project was indexed against. `NULL` means never git-diff-indexed (first run, or a project indexed before this column existed) — the indexer falls back to a full filesystem scan in that case. Only advances when a run completes with zero failures, so a partially-failed run gets retried from the same base next time. |

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

### `embedding_usage`

One row per embedding API call (indexing a batch of symbols, or embedding a `search_code` query) — powers `waycontext usage`. See [Tracking token usage & cost](#tracking-token-usage--cost).

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` (PK) | Internal ID. |
| `project_id` | `int` (FK → `projects.id`, nullable) | Which project triggered this call. `SET NULL` (not `CASCADE`) on project deletion — billing history survives a project being dropped. |
| `provider` | `text` | `voyage` or `openai`. |
| `model` | `text` | The embedding model used, e.g. `voyage-code-3`. |
| `input_type` | `text` | `document` (indexing) or `query` (a `search_code` call). |
| `tokens` | `int` | Token count the provider's API reported for this call (its `usage.total_tokens`). |
| `created_at` | `timestamptz` | When the call happened. |

Indexed on `project_id` and on `(provider, model)`.

## How `search_code` works

`search_code` is a hybrid search: it always runs a Postgres full-text query, and — when an embedding provider is configured — also runs a pgvector nearest-neighbor query, then merges the two ranked lists with Reciprocal Rank Fusion (RRF). (New to any of these terms? See [Algorithms & concepts explained](#algorithms--concepts-explained).)

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

### 2026-08-02 — v0.2.0

**Breaking: the package, CLI and MCP server are all called `waycontext` now.** The package was `code-context-mcp`, the CLI was `codecontext`, and the server identified itself as `code-context` while `install.sh` registered it as `waycontext` — so clients saw two names for one server, and the search hook's hardcoded `mcp__code-context__*` tool names never matched anything. The name is now read from `package.json` in one place so it can't drift again. The old `codecontext` and `code-context-mcp` binaries remain as aliases for one release; `install.sh` removes the pre-v0.2.0 global link, which otherwise kept ownership of the `codecontext` binary name. **Existing installs need `claude mcp remove --scope user <old-name>` if they registered under anything other than `waycontext`, and a Claude Code restart.** The `## Code Context MCP` heading in project `CLAUDE.md` files became `## WayContext`; both are recognised, so `waycontext init` migrates an existing section in place rather than appending a second one.

- Published to npm as `waycontext`, so `npx waycontext <command>` and `npm install -g waycontext` work. Verified by packing the tarball, installing it into a throwaway prefix and running it from outside the repo: the CLI, the aliases, the MCP server binary, migration discovery and `~/.config/waycontext/config.json` resolution all work with no `.env` anywhere near the install — the case the old `__dirname`-based config lookup could never have handled.
- Cut the tarball from 2.8 MB to 63 kB by excluding the three README diagrams, which were 97% of it and were being downloaded on every `npx` run. Setting `repository` in `package.json` means npm still renders them, resolving the relative paths against GitHub.
- Added `waycontext version`.

### 2026-08-02
- Added `docker/docker-compose.yml` (pgvector/pgvector:pg16, named volume, healthcheck) and made `install.sh` prefer it. Setup now tries an already-reachable database first, then Docker, then apt — previously apt was the only automated path, which made setup impossible on macOS or any non-Debian distro without following the manual instructions, and always required sudo. If the default port is occupied the installer picks the next free one and writes that into `DATABASE_URL` rather than failing to bind. The compose file requires an explicit `DB_PASS` and refuses to start with a default. Verified end to end against a throwaway container: all five migrations applied to a virgin database, the vector extension was present, and indexing plus search worked — the first time the baseline migration has been exercised building a schema from nothing rather than no-opping against an existing one.
- Stopped installing a C toolchain that was never used. The tree-sitter packages ship prebuilt N-API binaries (prebuildify + node-gyp-build) for linux-x64, darwin-x64, darwin-arm64 and win32-x64, so `npm install` uses those and never invokes node-gyp there — verified by installing the whole stack with no `cc`, `make` or `python3` on `PATH`, which completed in two seconds and parsed correctly. `install.sh` previously ran `sudo apt install build-essential python3` unconditionally; it now only offers a toolchain on platforms with no prebuild (linux-arm64, musl/Alpine, BSD) and only when one is actually missing. CI drops the same step and gained a guard that fails if a future dependency bump removes the prebuilds. A migration to WASM grammars was evaluated for this and rejected: the only maintained bundle (`tree-sitter-wasms`) is built against the tree-sitter 0.20 ABI, so it is incompatible with current `web-tree-sitter` and would also have *downgraded* the grammars this project uses.
- `install.sh` no longer hardcodes the database password. A fresh setup generates a random one and writes the resulting `DATABASE_URL` into `.env` (mode 600); an existing `.env` is reused as-is, so re-running the script never invalidates a working install.
- Configuration is now layered, highest precedence first: `process.env`, then `./.env`, then `<install dir>/.env`, then `~/.config/waycontext/config.json` (or `$WAYCONTEXT_CONFIG`), then built-in defaults. Previously the only source was an `.env` resolved relative to the module's own directory, which breaks under a global or `npx` install where that path points inside `node_modules`. `WAYCONTEXT_IGNORE_DOTENV=1` skips the `.env` files entirely, for containers where a bind-mounted source tree's `.env` would otherwise take over.
- Added the first tests for `src/parser.js`, which had none despite being the most logic-dense file in the repo, and fixed two bugs they exposed. **A re-index is needed to pick up the corrected data** — unchanged files are hash-skipped, so existing symbols keep their old names until their file changes or the project is deleted and re-indexed.
  - PHP's statement-form `namespace App\Domain;` prefixed nothing, because the declarations that follow it are siblings of the namespace node rather than children. Only the braced form worked. Since PSR-4/PSR-12 mandate the statement form, this meant essentially every modern PHP project stored unqualified names — `App\Billing\Invoice` and `App\Domain\Invoice` both collapsed to `Invoice` and resolved to each other. On this machine only 66 of 306,509 indexed PHP symbols carried a namespace.
  - A TypeScript `class C implements I` was recorded as `EXTENDS` pointing at the literal text `"implements I"`, because `class_heritage` wraps the `implements_clause` in TS so the `implements_clause` branch never matched. The edge could never resolve. (No such rows existed in the local index yet.)
- Added namespace-aware edge resolution to go with the parser fix. Qualifying symbol names alone would have made PHP graphs *worse*: call sites write `new Invoice()`, not the fully-qualified name, so exact matching stranded them. Measured over 300 real namespaced files, exact-match-only resolved 0.4% of targets versus 2.8% before namespaces were recorded at all. Two new passes restore it to 2.7% — one for fully-qualified references with a leading backslash, one matching the unqualified suffix, the latter only when exactly one symbol matches so an ambiguous name is left unresolved rather than pointed at an arbitrary class. A partial functional index on the namespace-stripped name keeps that pass off a sequential scan.
- Added an owning organisation for projects (`orgs` table, `projects.org_id`, `embedding_usage.org_id`). A single `default` org is created and every existing project is assigned to it, so nothing changes for a local install — the point is to add the tenant column while there is one tenant and the backfill is free. Project names are now unique per org rather than globally, and `getProject`/`listProjects`/`deleteProject`/`getOrCreateProject` take an optional org, defaulting to the one named by `ORG_SLUG`. Read paths were untouched: everything already filters by `project_id`, which becomes org-scoped transitively. A follow-up migration attributes pre-existing `embedding_usage` rows whose project had already been deleted (`project_id IS NULL`, so the join in the first backfill missed them) — without it, historical cost totals would have silently shrunk.
- Added CI (`.github/workflows/ci.yml`): the test suite now runs on Node 18/20/22 against a `pgvector/pgvector:pg16` service container, plus an MCP stdio handshake smoke test, a CLI smoke test that indexes this repo end to end, an assertion that re-running `migrate` applies nothing, and `npm pack --dry-run`. Nothing ran automatically before this.
- Replaced the inline `initDb()` DDL with a forward-only migration runner (`src/migrate.js`, `src/migrations/*.sql`). Migrations are applied in numeric order, once each, recorded in a `schema_migrations` ledger with checksums, serialized by a session-level advisory lock, and run one-per-transaction unless the file opens with `-- codectx:no-transaction` (for `CREATE INDEX CONCURRENTLY`). `${EMBEDDING_DIM}` is substituted from config before execution, and checksums are taken over the raw file text so changing that env var doesn't invalidate the ledger. A drifted checksum warns instead of failing — an operator who hand-edited a migration shouldn't be locked out of their own database. `0001_baseline.sql` is the previous schema verbatim and is written entirely with `IF NOT EXISTS`, so it applies as a no-op to existing databases with no stamping logic or dump/restore. `initDb()` kept its name and signature, so `install.sh`, `update.sh`, the MCP server's startup and every test were unchanged. New: `waycontext migrate [--status]`.
- Made the primary-search `PreToolUse` hook opt-in and advisory. It used to be installed globally and unattended by `install.sh` in deny mode, which degraded every project on the machine — including ones unrelated to this MCP — and blocked legitimate greps of docs, config and logs. Now: `waycontext hook install` (project-scoped by default, `--global` available) with three modes — `advise` (default; the grep runs and the agent just gets a note via the hook's `additionalContext`), `ask`, and `deny`. Project roots come from a JSON cache (`~/.cache/waycontext/projects.json`, refreshed by `hook install` and after every index) instead of a `psql` round-trip on every matching Bash command, so the hook adds no database dependency or latency to the agent's hot path; nested roots resolve to the deepest match. `install.sh` no longer writes anything into `~/.claude` beyond the MCP registration, and `waycontext uninstall` reverses the old setup — hook, global CLAUDE.md section and cache — leaving unrelated hooks and your own content intact.
- Consolidated every capability into a single registry (`src/operations.js`): one declaration per operation carrying its name, description, zod input schema, handler and CLI mapping. `src/server.js` (137 → 44 lines) loops over it to register MCP tools and `src/cli.js` loops over it to dispatch subcommands, so the two surfaces can no longer disagree about argument names, defaults or valid ranges, and `waycontext help` and every usage line are generated. This fixed a real asymmetry: the zod ranges only ran on the MCP side, so the CLI had been silently accepting `search_code … 9999` and `get_graph … 99`. Numeric fields use `z.coerce.number()` so one schema serves both a real number from MCP and an argv string from the CLI — the generated JSON schema is byte-identical to before.
- Added `CONTRIBUTING.md`, `NOTICE` and `TRADEMARK.md`. The code stays Apache-2.0; the name and logo are reserved.

### 2026-07-29
- Moved the "Setup on Ubuntu" installation guide to the top of the README, right after the intro, instead of after the architecture/algorithms/pricing sections.
- Added `waycontext init-global`: writes (or updates) a `## WayContext Workflow` section into the user's global `~/.claude/CLAUDE.md`, so every project's Claude Code session — not just ones with their own `CLAUDE.md`/`.mcp.json` — prefers `search_code`/`get_graph`/`get_callers`/`get_symbol` over `Grep`/`Glob`/`Explore` when a project is indexed. Unlike project-scoped `init`, it's non-interactive and idempotent (no project name involved), so `install.sh` now runs it automatically (best-effort) right after registering the MCP server.
- Fixed a crash-recovery gap in `indexProject()`'s embedding phase: if the process died (or a Voyage batch failed) after files/symbols were already committed, their content hash matched on the next run, so they were hash-skipped forever and stayed without embeddings. `runIndex()` now re-checks for symbols with `embedding IS NULL` before embedding, so a plain re-run of `index`/`reindex` heals any left over from an earlier crash. Embedding calls are also now chunked (64 symbols) with per-chunk DB writes, so a failing chunk no longer discards vectors already fetched from earlier chunks in the same run.
- Added `hooks/codectx-primary-search.sh` plus `waycontext init-global` support (`src/hookInit.js`): installs a `PreToolUse` hook into `~/.claude/settings.json` that denies `Grep`-tool calls and `grep`/`rg`/`ag` Bash commands whenever the working directory is a project this MCP has indexed, redirecting the caller to `search_code`/`get_symbol`/`get_callers`/`get_graph` instead of a soft reminder — the CLAUDE.md instruction alone wasn't reliably followed. A trailing `# codectx-skip` comment bypasses the check once for legitimate non-code searches (docs, config, logs, test output). Idempotent and self-locating (no hardcoded paths), so `install.sh` sets this up automatically on a fresh clone.
- Added `update.sh` (and `npm run update`): pulls the latest commits (fast-forward only, aborting rather than merging on divergent history or uncommitted local changes) and re-runs `install.sh` so an existing install's npm deps, DB schema, CLI link, MCP registration, global CLAUDE.md section, and PreToolUse hook all get refreshed in one step — additive, never overwrites customized config.
- Added `check-update.sh --install`: a read-only cron check (fetch + compare against origin, no pull, no `install.sh`) that runs every 5 minutes — a fixed daily time isn't reliable on a laptop that isn't always on — but debounces to at most one `notify-send`/log line per calendar day (`~/.cache/waycontext/last-notified-date`), with current status overwritten each run at `~/.cache/waycontext/status` instead of growing unbounded. `--install` upgrades the crontab line in place if the schedule changes instead of leaving a stale duplicate; `--uninstall` removes it; both only touch their own marker-tagged crontab line.

### 2026-07-27
- Fixed a `deadlock detected` (`40P01`) / foreign-key-violation (`23503`) race when two `index_project` runs overlap on the same project (e.g. a commit-hook reindex racing a pull-hook reindex from another session): `indexProject()` now holds a Postgres session-level advisory lock keyed by the project's id for the run's duration, serializing overlapping runs on the same project while leaving other projects free to index in parallel.
- `waycontext index_project` (and its `index`/`reindex` aliases) now runs the CLI spinner for its whole duration instead of skipping it, pausing around its own per-step progress lines so the animation doesn't look stuck during the previously-silent file-by-file processing.

### 2026-07-23
- Added `install.sh`: one-command first-time setup for a fresh clone (PostgreSQL + pgvector, `npm install`, `.env`, `init-db`, `npm link`, and registering the MCP server with Claude Code at user scope via `claude mcp add --scope user waycontext`). Idempotent — safe to re-run.
- Added `waycontext init`: interactively prompts for a project name and writes/updates a `## WayContext` section in `./CLAUDE.md`, asking for y/N confirmation before overwriting an existing section.
- Added `reindex` as another alias for `index_project` (alongside `index`), so the CLI's re-run-after-a-git-diff command reads more naturally.

### 2026-07-22
- Added `projects.last_indexed_sha`, and `indexProject()` now uses it to scope file discovery to `git diff` since the last indexed commit (falling back to a full scan on first index, a non-git root, or when the stored SHA is no longer an ancestor of `HEAD`, e.g. after a rebase) — re-indexing a large repo after a small change no longer requires re-hashing every file.
- Fixed `last_indexed_sha` advancing even when a reindex run had per-file failures; it now only advances after a fully successful run, so failed files stay in the next run's diff instead of silently dropping out of the index.

### 2026-07-21
- Added a reference pricing table (fetched from Voyage's and OpenAI's own docs) to "Tracking token usage & cost", and set `VOYAGE_PRICE_PER_1M_TOKENS`/`OPENAI_PRICE_PER_1M_TOKENS` in `.env` to match.
- Added an "Algorithms & concepts explained" section: plain-language explanations (with Mermaid/ASCII diagrams) of AST parsing, SHA-256 incremental hashing, BFS graph traversal, vector embeddings/cosine distance, HNSW, weighted full-text search, and Reciprocal Rank Fusion — cross-linked from where each term first appears.
- Added `waycontext usage [project]`: every embedding API call now logs its provider/model/input_type and reported token count to a new `embedding_usage` table, viewable as an aggregate report with an estimated cost column when `VOYAGE_PRICE_PER_1M_TOKENS`/`OPENAI_PRICE_PER_1M_TOKENS` is set in `.env`.
- Fixed the CLI spinner showing `✔` (success) even when the wrapped command threw; it now shows `✖` on failure.
- Added a spinner + live elapsed-time indicator to every DB/network-backed `waycontext` subcommand (e.g. `⠹ Searching "..."… 0.8s` → `✔ Searching "..." (1.2s)`), written to stderr so stdout JSON stays pipeable; falls back to a single plain line in non-TTY contexts. `index_project` keeps its own step-by-step log output instead.
- Added a `waycontext` CLI: `src/cli.js` now exposes every MCP tool (`search_code`, `get_symbol`, `get_callers`, `get_callees`, `get_graph`, `get_file_outline`, `find_related`, `project_overview`, `list_projects`) as a subcommand, in addition to the existing `index`/`stats`/`init-db`. Registered as a `bin` entry in `package.json`; run `npm link` to get a global `waycontext` command.
- Added `waycontext db` (interactive `psql` session against `DATABASE_URL`) and `waycontext tables [table] [limit]` (list tables with row counts, or browse a table's rows) for inspecting the Postgres schema directly from the terminal.
- Added a "Database schema" section documenting all 4 tables (`projects`, `files`, `symbols`, `edges`), every column's meaning, and how they relate, so the Postgres structure is understandable without reading `src/db.js`.

### 2026-07-18
- Fixed `Parse failed: ... (Invalid argument)` errors on larger source files: `parseFile` now passes an explicit `bufferSize` to tree-sitter's `parse()`, avoiding a chunked-read bug in the native binding that triggered once file content reached 32768 UTF-16 units.
- Added hybrid search (full-text + pgvector ANN, RRF-fused) to `search_code`.
- Documented why an embedding provider (Voyage/OpenAI) is needed and added a "How `search_code` works" section explaining the full-text/vector/RRF fusion.
