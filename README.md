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
> **No compiler needed.** The tree-sitter packages ship prebuilt binaries — every grammar covers linux-x64, darwin-x64, darwin-arm64 and win32-x64, and the Python/Go grammars add linux-arm64 and win32-arm64. Only platforms with no prebuild (musl/Alpine, BSD, and linux-arm64 for the older grammars) compile from source and need `build-essential` + `python3`; `install.sh` offers those there and nowhere else.

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
- **Languages:** JavaScript, TypeScript, JSX/TSX, PHP, Python, Go (extendable in `src/parser.js`)
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
| `get_history` | Commits that touched a file, symbol or directory, with issue refs — "what broke last time someone touched this?" |
| `who_owns` | Recency-weighted contributors for a file, symbol or directory — "who should I ask about this?" |
| `search_knowledge` | Code **and** docs/ADRs in one fused ranking — "why is it this way?", where the answer is prose rather than a function body. |
| `get_rules` | Human-confirmed rules that apply to a file, symbol or directory. Candidates are never returned. |
| `remember` | Record a gotcha, fix, convention or postmortem so it outlives the session. |
| `recall` | Search engineering memory before re-debugging something already hit once. |
| `review_context` | Rules + memories + recent fixes for the working-tree diff — "what should I know about what I'm about to commit?" |

## Database schema

Parsed code is stored as files → symbols → edges; on top of that sit the identity and knowledge tables described under [Stable identity](#stable-identity-symbol-keys-and-entities). Browse any of them directly with `waycontext tables` / `waycontext db` (see [CLI](#3-cli)).

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

### `documents`

One row per ingested Markdown file — a 1:1 satellite of `entities(kind='document')`. The
embeddable text lives in `chunks`; this table owns what you filter and aggregate on.

| Column | Type | Meaning |
|---|---|---|
| `entity_id` | `bigint` (PK, FK → `entities.id`) | The durable id. Knowledge attaches here, not to the file row. |
| `file_id` | `bigint` (FK → `files.id`) | The `files` row docs share with code, which is what gives them the sha256 hash-skip and deletion cascade for free. |
| `path` | `text` | Repo-relative path. Unique per project, and the entity's `natural_key`. |
| `doc_type` | `text` | `adr` \| `readme` \| `changelog` \| `contributing` \| `guide` \| `note`. |
| `title` | `text` | Frontmatter `title`, else the first heading, else the filename. |
| `frontmatter` | `jsonb` | The parsed `---` block. |
| `adr` | `jsonb` | `{status, context, decision, consequences}` for `doc_type='adr'`, else `NULL`. |
| `mentions` | `jsonb` | `{paths, identifiers}` — the prose references found in the document. GIN-indexed. |
| `content_hash` | `text` | sha256 of the file, mirroring `files.hash`. |
| `chunk_count` | `int` | How many `chunks` rows this document currently has. |

**Why `mentions` is jsonb and not link rows.** Backticked identifiers that match exactly
one symbol become `entity_links(relation='MENTIONS')` — the same "unique match or nothing"
rule the namespaced-edge resolver uses. Path references stay in this column instead,
because a file is not an entity here, so the only available link target would be *every*
symbol in that file: one prose mention of `src/graph.js` would become a dozen link rows and
drown the specific ones. "Which docs mention this file?" is one indexed query:

```sql
SELECT path FROM documents WHERE mentions->'paths' ? 'src/graph.js';
```

### `rules`

Prescriptive project knowledge — the things an agent should be told before it writes code.
A 1:1 satellite of `entities(kind='rule')`.

| Column | Type | Meaning |
|---|---|---|
| `entity_id` | `bigint` (PK) | The durable id. `natural_key` is `rule:<hash of statement + scope>`, so re-extraction converges instead of duplicating. |
| `statement` | `text` | The rule, as one sentence. |
| `scope` | `text` | A glob (`src/payments/**`) matched with picomatch. `NULL` means project-wide. |
| `severity` | `text` | `low` \| `medium` \| `high` \| `critical` — the ordering of `get_rules`. |
| `origin` / `origin_ref` | `text` | Where it came from: `adr` \| `doc` \| `fix_commit` \| `manual` \| `imported`, plus the doc path, commit sha or YAML file. |
| `confidence` | `real` | Cue strength at extraction time. Orders the candidate queue; does **not** gate injection. |
| `state` | `text` | `candidate` \| `active` \| `rejected`. **Only `active` is ever injected.** |
| `verified_by` / `verified_at` | | Who confirmed it, and when. |

### `memories`

Observational knowledge — what this project has learned. A 1:1 satellite of
`entities(kind='memory')`.

| Column | Type | Meaning |
|---|---|---|
| `entity_id` | `bigint` (PK) | `natural_key` is `mem:<hash of content + scope>`, so remembering the same thing twice is idempotent. |
| `kind` | `text` | `fix` \| `gotcha` \| `convention` \| `postmortem`. |
| `content` | `text` | The memory itself. Also written to `chunks`, which is what makes it searchable. |
| `scope` | `text` | Optional glob, used by `review_context`. |
| `source` | `text` | `agent` \| `human` \| `extracted` \| `imported`. |
| `supersedes` | `bigint` | The memory this one corrects. The old row stays readable but stops being recalled. |
| `pinned` | `boolean` | Always returned first by `recall`. |

Memories deliberately have **no embedding column of their own**: their text goes through the
Phase 2 chunker into `chunks`, inheriting the HNSW index, the generated `fts_vector`, the
embed-on-`NULL` healing pass and the embeddings-off degradation already built for
documents. Rules get neither chunks nor embeddings, because they are selected by scope
match and never by similarity — a rule can't be pulled into context just for sounding
relevant.

## Rules & engineering memory

Two kinds of durable knowledge, with deliberately different rules about who may create
them.

**Rules are prescriptive, so extraction only ever proposes.** At the end of every index,
normative sentences are pulled out of ADR Decision/Consequences sections, other in-repo
prose, and fix-commit messages — `never …`, `must …`, `always …`, `should …` — scored by cue
strength and stored as `state='candidate'`. Nothing reaches an agent until a human
confirms it:

```bash
waycontext rule candidates              # review the queue, best-first
waycontext rule confirm 4213            # → state='active', now injected
waycontext rule reject 4217             # → permanent; re-extraction won't resurrect it
waycontext rules src/payments/api.js    # what applies here (confirmed only)
```

`rule confirm` is **not** an MCP tool, and that is the point: an agent that could promote
its own extracted guesses into injected rules is the failure mode this design exists to
prevent. A confidently wrong rule makes an agent measurably worse, and unlike a bad search
result it is not self-correcting — the agent has no way to know the rule was invented. A
test asserts these commands stay off the MCP surface.

**Memories are observational, so the agent writes them directly.** The cost of a wrong
memory is one bad search result:

```bash
waycontext remember myproject "Charging twice in one request trips the gateway's duplicate filter." gotcha
waycontext recall myproject "duplicate charge"
```

Correcting a memory supersedes it rather than editing it — the old belief stays readable,
which is often the useful part, but stops being recalled.

**`review_context` is the call to make before reviewing a diff.** It defaults to the
working tree, including untracked files, so a brand-new file still picks up the rules that
govern it:

```bash
waycontext review myproject                     # uncommitted changes
waycontext review myproject src/a.js,src/b.js   # specific paths
```

### Team sharing: `.waycontext/knowledge/*.yaml`

```bash
waycontext knowledge-export     # rules.yaml, candidates.yaml, memories.yaml
waycontext knowledge-import     # also runs automatically at the start of each index
```

Commit that directory and every developer pointed at their own database gets the same
rules. A rule can therefore be promoted two ways — `rule confirm`, or a maintainer moving
an entry into `rules.yaml` and merging the PR.

**Import is additive and promoting only. It never deletes, never deactivates, and never
downgrades an active rule to a candidate.** That is the hazard of having two promotion
paths: a stale checkout must not silently switch off a rule someone confirmed by CLI.
Deactivation is always explicit, through `rule reject`.

Configure with `RULES_ENABLED`, `RULE_CANDIDATE_MIN_CONFIDENCE` (default `0.4` — below it a
sentence isn't even proposed) and `KNOWLEDGE_DIR`.

## Docs & ADRs: `search_knowledge`

Indexing a project also ingests its Markdown — READMEs, guides and above all Architecture
Decision Records — so an agent can answer *why* the code is shaped the way it is, not only
where it lives. Like git history: no configuration, no API keys, no network.

```bash
waycontext knowledge myproject "why do we fuse two ranked lists"
```

Docs ride the **same** pipeline as code: git-diff scoping, the sha256 hash-skip and the
deleted-file cascade all key on a path and were already correct for prose. What differs is
what happens after the read — instead of parse → symbols → edges, a document becomes an
entity, a `documents` row and a set of `chunks`.

**Chunking rules that matter.** Chunks carry a heading breadcrumb (`Architecture > Storage
> Chunking`), which is weighted above the body in full-text ranking. A fenced code block is
never split — half a code block retrieves as noise. The target is 4800 characters with a
hard cap of 8000, matching the input slice in `src/embeddings.js`, so the text stored can
never differ from the text the vector was computed from. A heading with no body of its own
rides along on the chunk it introduces rather than becoming a bare-title chunk.

**Re-embedding is per chunk, not per document.** Each chunk stores its own
`content_hash`, and a re-index invalidates the embedding only where that hash changed:
edit one heading in a 40-section ADR and exactly one chunk is re-embedded. The same
`embedding IS NULL` query that finds those chunks also heals a run that crashed mid-embed,
so there is one recovery path rather than two.

`search_knowledge` fuses up to four ranked lists — symbol full-text, symbol vector, chunk
full-text, chunk vector — through the same RRF as `search_code`, using namespaced ids
(`sym:123`, `chunk:456`). With `EMBEDDING_PROVIDER=none` only the full-text lists exist and
it degrades exactly the way symbol search already does.

`search_code` was deliberately **not** changed. It is the call agents make by default and
its quality is measured by [`eval/`](#retrieval-quality-eval) against real commits, so
mixing prose into it would move a number that has to stay comparable across phases.

Configure with `DOCS_ENABLED`, `DOCS_GLOBS` (default `**/*.md,**/*.mdx`) and
`DOCS_CHUNK_CHARS`. `.gitignore` and the built-in ignores still apply, so `node_modules`
and `vendor` docs never get walked.

> **Already-indexed projects need one full scan.** Re-indexing is scoped to `git diff`
> since `projects.last_indexed_sha`, so docs that haven't been edited since your last index
> are in no diff and will never be picked up by an incremental run. One full scan fixes it
> permanently:
>
> ```sql
> UPDATE projects SET last_indexed_sha = NULL WHERE name = 'myproject';
> ```
>
> then `waycontext index myproject <path>` once. New projects need nothing — their first
> index is a full scan anyway.

## Git history: `get_history` and `who_owns`

Indexing a project also reads its git history — no configuration, no API keys, no
network. `index_project` runs one streaming `git log` pass and records commits, per-file
churn, contributor identities (via `.mailmap`), and any issue numbers mentioned in commit
messages.

```bash
waycontext history  myproject src/auth/jwt.php     # what happened to this, and why
waycontext owners   myproject verifyToken          # who to ask about it
waycontext history  myproject                      # recent project-wide activity
```

The target can be a **file path**, a **symbol name** or a **directory** — or omitted for
the whole project.

**Ownership decays.** `who_owns` weights each commit by `exp(-ln2 · age / half-life)`,
with a 180-day half-life (`OWNERSHIP_HALF_LIFE_DAYS`). A plain commit count answers "who
wrote most of this in 2019", which is not who you want to ask today. Merge commits are
excluded — they rank whoever runs the integrations, not whoever understands the code.

**Issue references work with zero integrations.** `#1532`, `PROJ-1532`, `fixes #34` and
tracker URLs are pulled out of commit messages, and a referenced issue that has no
ingested record still gets an entity row, marked `source = 'inferred'`. So
issue↔code linkage works before you have connected anything; a real Jira or GitHub
connector later fills in title/state/labels on the same rows rather than replacing them.

**History survives file moves.** Ask for a symbol's history and you get it from before
the file was renamed, because the symbol's identity is tracked separately from its
location — see [Stable identity](#stable-identity-symbol-keys-and-entities).

Incremental on re-index via `projects.last_history_sha`, with the same
`merge-base --is-ancestor` guard as the code index: if history was rewritten, it falls
back to a full pass instead of silently skipping commits. The first pass over a
repository is bounded by `HISTORY_WINDOW_MONTHS` (24) and `HISTORY_MAX_COMMITS` (20000);
set either to `0` to remove the bound, or `HISTORY_ENABLED=0` to skip history entirely.

## Stable identity: symbol keys and entities

`symbols` is disposable by design — re-indexing a changed file deletes and reinserts
every symbol in it, so `symbols.id` is reassigned constantly. Nothing durable can be
attached to an id like that, which is why there is a second layer:

| Plane | Tables | Lifecycle |
|---|---|---|
| Parse | `files`, `symbols`, `edges` | rebuilt from source, ids churn |
| Identity | `entities`, `symbol_aliases` | append + tombstone, ids never reused |
| Knowledge | `commits`, `commit_files`, `people`, `issues`, `entity_links`, `chunks` | durable |

Every symbol gets a **symbol key** — `src/graph.js#function:searchCode`, with a `~n`
suffix for duplicates in one file — and an `entities` row keyed on it. Deliberately
*not* a content hash: a content hash changes on every edit, which is exactly the moment
the link has to survive.

When a symbol moves or its file is renamed, the index run pairs the key that vanished
with the key that appeared (by identical body fingerprint, then by identical kind and
name) and carries the **same entity** across, recording the old key in `symbol_aliases`.
A symbol that genuinely goes away is tombstoned with `deleted_at`, not deleted — if it
comes back, it gets its original id back. Renaming an identifier *in place* is not
matched, and reads as delete + create: the declaration is part of the body, so both the
name and the fingerprint changed, and nothing is left that distinguishes it from two
unrelated edits.

**Upgrading an existing install.** Symbols indexed before this existed have no key and no
entity. They pick one up for free the next time their file changes, so nothing is
required of you. To do it now, without reparsing anything:

```bash
waycontext backfill-identity                 # all projects
waycontext backfill-identity myproject       # one project
waycontext backfill-identity --status --json # what's left to do
```

It is batched by file, resumable, and safe to interrupt. This is a command rather than
part of the migration on purpose: `symbols` carries a `vector(1024)` column, a stored
generated `tsvector` and a multi-gigabyte HNSW index, so any statement touching every row
rewrites the whole heap and re-inserts every vector into the HNSW graph. On a 326k-symbol
database that measured **over 12 minutes** — and migrations run at MCP server startup,
which would have meant 12 minutes of a client that looks hung.

## Retrieval quality: `eval/`

Every repository ships its own labelled dataset for free. A commit is a natural-language
description of an intent paired with the exact set of files that intent turned out to
touch — so replaying commits measures retrieval against real ground truth, in your
codebase, in your domain vocabulary, with nothing to annotate.

```bash
npm run eval -- myproject --commits 100 --k 10
```

Reports `recall@k` (of the files a commit touched, what fraction came back in the top k),
hit rate, and MRR. Merges, reverts, one-word subjects and sprawling refactors are
excluded; sampling is a deterministic stride, so two runs score the same commits and a
before/after comparison means something.

Read the absolute number sceptically — a commit message is a lossy description of a diff,
so perfect recall is neither achievable nor the goal. It is for comparing WayContext to
WayContext across a retrieval change.

> **Finding from the first run:** with `EMBEDDING_PROVIDER=none`, recall@10 on this
> repository's own history is **0.00** — `plainto_tsquery` ANDs every term, so a
> natural-language query returns nothing at all unless one symbol happens to contain all
> of its words. With embeddings on, the same 26 commits score recall@10 **0.66**, hit rate
> **0.92**, MRR **0.73**. The "degrades gracefully to full-text" story does not currently
> hold for natural-language queries.

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

### 2026-08-03 — Phase 3: rules & engineering memory

- **`rules` and `memories`**, two more satellites of `entities`. Rules are prescriptive and
  glob-scoped; memories are observational and searchable. The split that matters is who may
  create them: `remember` is an MCP tool the agent calls itself, while a rule can only be
  *proposed* by extraction and *confirmed* by a human. An agent able to promote its own
  guesses into injected rules is the one failure mode here that isn't self-correcting — a
  bad search result gets ignored, an invented rule gets followed.
- **Extraction proposes at the end of every index.** Normative sentences (`never`, `must`,
  `always`, `should`) are pulled from ADR Decision/Consequences sections, other in-repo
  prose and fix-commit messages, scored by cue strength, and written as
  `state='candidate'`. The satellite upsert refreshes wording and provenance but **never**
  touches `state`, `confidence` or `verified_by`, so a confirmed rule survives
  re-extraction and a rejected one is never resurrected. Re-extraction has no watermark and
  doesn't need one: the natural key is derived from the statement, so the upsert converges.
- **New tools `get_rules`, `remember`, `recall`, `review_context`** (CLI: `rules`,
  `remember`, `recall`, `review`). `review_context` defaults to the working-tree diff
  including untracked files, because a brand-new file is exactly the one whose rules you
  want. Human-only: `rule candidates`, `rule confirm`, `rule reject`, `knowledge-export`,
  `knowledge-import`, all bespoke CLI cases rather than registry entries so they are
  structurally absent from MCP — with a test asserting it stays that way.
- **Memories reuse the chunk path instead of growing an embedding column.** A memory's text
  goes through the Phase 2 chunker into `chunks`, so it inherits the HNSW index, the
  generated `fts_vector`, the embed-on-`NULL` healing pass and the embeddings-off
  degradation. Consequences: the indexer's pending-chunk query and `searchKnowledge`'s
  candidates now join `entities` with a `LEFT JOIN documents` rather than requiring a
  document row, chunk embedding no longer depends on `DOCS_ENABLED`, and memories surface
  in `search_knowledge` tagged `type: "memory"`. Rules get no chunks at all — they are
  selected by scope, never by similarity.
- **Team sharing through `.waycontext/knowledge/*.yaml`**, imported automatically at the
  start of each index. Import is additive-and-promoting only: it never deletes, never
  deactivates, and never downgrades an active rule listed as a candidate, so a stale
  checkout can't switch off a rule someone confirmed by CLI.
- **Added `js-yaml`** — the first new runtime dependency since `picomatch`. Phase 2
  hand-rolled frontmatter parsing to avoid one, which was right for read-only metadata we
  generate ourselves; this file is hand-edited by humans and needs block scalars, and a
  fragile parser that eats a rule on someone's `|` block is the worse trade. Note it is
  ESM-first with named exports only: `import { load, dump } from "js-yaml"`.
- **Fixed a real collision the parity suite caught:** `knowledge` is already the CLI alias
  of `search_knowledge`, and operations dispatch before the bespoke commands — so a
  `knowledge export` subcommand would have run a *search* for the word "export". The admin
  commands are flat (`knowledge-export`/`knowledge-import`), and a new test asserts no
  human-only command is resolvable as an operation.
- **This repo now carries its own `.waycontext/knowledge/`** — one confirmed rule and one
  memory, dogfooding the sharing mechanism. `candidates.yaml` is gitignored instead:
  candidates are re-derived deterministically from the same docs and commits on every
  index, so committing them shares no decision a re-index wouldn't reproduce, while
  `rules.yaml` and `memories.yaml` hold human judgement that cannot be regenerated.

### 2026-08-03 — Phase 2: docs & ADR ingestion

- **In-repo Markdown is now indexed** (`DOCS_GLOBS`, default `**/*.md,**/*.mdx`): a
  document becomes an `entities(kind='document')` row, a `documents` satellite and a set of
  `chunks`. It rides the existing pipeline rather than a parallel one — git-diff scoping,
  the sha256 hash-skip and the deleted-file cascade all key on a path and were already
  correct for prose, so docs cost three edits to the discovery/branch logic instead of a
  second ingestion path.
- **New tool `search_knowledge`** (CLI: `knowledge`), fusing symbol full-text, symbol
  vector, chunk full-text and chunk vector through the *existing* `fuseRankedLists` with
  namespaced `sym:`/`chunk:` ids — `src/rrf.js` needed no change, since it already keyed on
  opaque ids. Results are tagged `type: "code"` or `type: "doc"`, and doc hits carry the
  heading path they came from. `search_code` is untouched on purpose: it is what agents
  call by default and `eval/` measures its recall against real commits, so prose must not
  move that number.
- **ADRs are parsed, not just chunked.** Location, a numbered filename, a frontmatter
  `status`, or a Context+Decision heading pair each classify a document as an ADR, and its
  Context / Decision / Consequences sections land in `documents.adr` for later aggregation.
  Phase 3 is what turns those into rules; this phase only records them.
- **Re-embedding is per chunk.** Each chunk hashes its own heading path plus body, and a
  re-index nulls the embedding only where that hash changed — edit one heading in a
  40-section ADR and one chunk is re-embedded. The `embedding IS NULL` query that picks
  those up is the same one that heals a crashed run, so there is one recovery mechanism
  instead of two.
- **Chunking rules with a reason each:** never split a fenced code block (half a block
  retrieves as noise); heading breadcrumbs weighted above body text in FTS; a heading with
  no body of its own rides on the chunk it introduces instead of becoming a bare-title
  chunk; hard cap 8000 characters to match the input slice in `src/embeddings.js`, so
  stored text can never differ from what was embedded.
- **`eval/recall.js` now requires ground-truth files to contain symbols.** Indexing docs
  gives them `files` rows, which silently pulled prose-only commits into the sample — and
  `search_code` returns symbols, so those commits were unanswerable by construction and
  dragged recall@10 from 0.66 to 0.38 without a single retrieval path changing. Scoring a
  symbol search against files that have no symbols measures nothing; doc retrieval needs
  its own harness against `search_knowledge`.
- **Enabling docs on an existing project needs one full scan** — incremental runs are
  scoped to `git diff`, and docs untouched since the last index appear in no diff. See the
  note under [Docs & ADRs](#docs--adrs-search_knowledge).
- **Doc→code links are conservative.** A backticked identifier matching exactly one symbol
  becomes `entity_links(relation='MENTIONS')`; ambiguous names are left unlinked, as the
  namespaced-edge resolver already does. Path references stay in `documents.mentions` under
  a GIN index rather than fanning out to every symbol in the file.

### 2026-08-03 — Phase 1: identity + git history

- **Git history ingestion.** `index_project` now also reads the repository's git history
  in one streaming `git log` pass — commits, per-file churn, `.mailmap`-resolved
  contributor identities, co-author trailers, fix/revert/merge classification and issue
  references. No subprocess per commit: the existing `execFile` approach in `gitDiff.js`
  is fine for a diff and would buffer a 100k-commit log into a single string. Incremental
  via `projects.last_history_sha`, bounded on first pass by `HISTORY_WINDOW_MONTHS` /
  `HISTORY_MAX_COMMITS`, and it never fails an index — a directory that isn't a git repo
  just reports no history.
- **New tools `get_history` and `who_owns`** (CLI: `history`, `owners`), accepting a file,
  a symbol, a directory or nothing. Ownership is recency-weighted with a 180-day
  half-life, because a raw commit count tells you who wrote it, not who remembers it.
- **Stub issues.** An issue referenced by a commit gets an entity even with no tracker
  configured, so issue↔code linkage works before anything is connected. A connector
  later enriches the same rows.
- **The identity plane** — `entities`, `entity_links`, `symbol_aliases`, plus
  `symbol_key` / `body_fingerprint` / `entity_id` on `symbols`. Symbols now have an id
  that survives reindexing, renames and file moves, which is what any durable knowledge
  has to attach to. Moved symbols carry their entity across and record an alias; deleted
  ones are tombstoned and get their original id back if they return.
- **`waycontext backfill-identity`** for existing installs, batched and resumable. This
  deliberately did *not* go in the migration: the same work as three `UPDATE`s over
  `symbols` took **over 12 minutes** on a 326k-symbol database, because the table carries
  a `vector(1024)` column, a stored generated `tsvector` and a 1.6 GB HNSW index — and
  migrations run at MCP server startup. Nothing depends on having run it; new indexing
  populates identity at INSERT time.
- **`eval/`** — retrieval-quality harness replaying real commits from a repository's own
  history. First result on this repo: recall@10 **0.66** / hit rate **0.92** / MRR
  **0.73** with embeddings on, and **0.00** with them off, because `plainto_tsquery` ANDs
  every term. Full-text-only mode does not currently answer natural-language queries at
  all; that is now a measured number rather than a suspicion.
- 66 new tests (146 → 212). Also fixed a pre-existing test guard that checked for an API
  key but not whether the provider was enabled, so `EMBEDDING_PROVIDER=none npm test`
  crashed instead of skipping when a key was present in `.env`.

### 2026-08-02 — v0.2.0

**Breaking: the package, CLI and MCP server are all called `waycontext` now.** The package was `code-context-mcp`, the CLI was `codecontext`, and the server identified itself as `code-context` while `install.sh` registered it as `waycontext` — so clients saw two names for one server, and the search hook's hardcoded `mcp__code-context__*` tool names never matched anything. The name is now read from `package.json` in one place so it can't drift again. The old `codecontext` and `code-context-mcp` binaries remain as aliases for one release; `install.sh` removes the pre-v0.2.0 global link, which otherwise kept ownership of the `codecontext` binary name. **Existing installs need `claude mcp remove --scope user <old-name>` if they registered under anything other than `waycontext`, and a Claude Code restart.** The `## Code Context MCP` heading in project `CLAUDE.md` files became `## WayContext`; both are recognised, so `waycontext init` migrates an existing section in place rather than appending a second one.

- Published to npm as `waycontext`, so `npx waycontext <command>` and `npm install -g waycontext` work. Verified by packing the tarball, installing it into a throwaway prefix and running it from outside the repo: the CLI, the aliases, the MCP server binary, migration discovery and `~/.config/waycontext/config.json` resolution all work with no `.env` anywhere near the install — the case the old `__dirname`-based config lookup could never have handled.
- Cut the tarball from 2.8 MB to 63 kB by excluding the three README diagrams, which were 97% of it and were being downloaded on every `npx` run. Setting `repository` in `package.json` means npm still renders them, resolving the relative paths against GitHub.
- Added `waycontext version`.
- Added **Python** (`.py`, `.pyi`) and **Go** (`.go`) parsing. Python contributes classes, methods (including decorated ones, which wrap the definition they annotate), functions, base classes, and both import forms; Go contributes functions, structs, interfaces, imports in either syntax, composite literals as instantiation, and methods named after their receiver type (`Server::Handle`) to match how methods are named in every other language here. Pinned to `tree-sitter-python@0.23.4` / `tree-sitter-go@0.23.4`, the newest releases whose peer dependency still matches the tree-sitter core in use — the current 0.25 releases require a core bump, and forcing them with `--legacy-peer-deps` risks an N-API ABI mismatch that fails as a segfault rather than an error. Both ship prebuilt binaries for six platforms, so they add no build requirement; the CI guard now covers them too.
- **Known gap, unchanged by the above:** a call written `this.method()` / `self.method()` / `obj.method()` records its callee verbatim, so it doesn't resolve to the method it targets. 606,671 of 1,542,104 unresolved edges in a local index are of this shape, 87,560 of them specifically `this.*`/`self.*`. This has always applied to JavaScript and TypeScript — PHP avoids it because member calls are parsed to the bare method name — and Python inherits it, where it matters more because methods are almost always reached through `self`. Worth fixing next in the parser.

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
