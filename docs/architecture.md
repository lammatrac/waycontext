# Architecture & data model

How the pieces fit together, what every table holds, and why identity is a separate plane
from the parse plane.


![Architecture](https://raw.githubusercontent.com/lammatrac/waycontext/main/src/images/architecture.png)

- **One operation registry:** every capability is declared once in `src/operations.js` — name, description, zod input schema, handler, and how it maps onto a CLI invocation. `src/server.js` loops over that list to register MCP tools and `src/cli.js` loops over it to dispatch subcommands, so the two surfaces cannot drift apart on argument names, defaults, or valid ranges, and `waycontext help` is generated rather than hand-maintained. Adding a capability means adding one entry.
- **Languages:** JavaScript, TypeScript, JSX/TSX, PHP, Python, Go (extendable in `src/parser.js`)
- **Graph relations:** `CALLS`, `INSTANTIATES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `REGISTERS_HOOK`, `FIRES_HOOK` (WordPress `add_action`/`do_action`/`apply_filters` aware)
- **Incremental indexing:** SHA-256 per file; unchanged files are skipped, deleted files are pruned. When a project's root is inside a git repo and it's been indexed before, re-runs scope file discovery to `git diff` since the last indexed commit instead of a full filesystem scan
- **Embeddings:** Voyage (`voyage-code-3`, recommended for code) or OpenAI, or `none` (graph + keyword search still work)

New to terms like AST, BFS, HNSW, cosine distance, or RRF? See [Algorithms & concepts explained](algorithms.md).

## Database schema

Parsed code is stored as files → symbols → edges; on top of that sit the identity and knowledge tables described under [Stable identity](#stable-identity-symbol-keys-and-entities). Browse any of them directly with `waycontext tables` / `waycontext db` (see [CLI](installation.md#3-cli)).

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
| `body` | `text` | The symbol's source code, truncated to 6 KB (see [Notes & limits](../README.md#notes--limits)). |
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

One row per embedding API call (indexing a batch of symbols, or embedding a `search_code` query) — powers `waycontext usage`. See [Tracking token usage & cost](installation.md#tracking-token-usage--cost).

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

### The derived plane

`modules`, `module_members`, `module_deps`, `module_metrics`, `cochange`, `ownership`,
`bug_clusters`, `bug_cluster_members`, plus a `derived_state` watermark row per kind.

Everything here is a **fourth** layer, and the important thing about it is that it is
disposable like the parse plane rather than durable like the knowledge plane:

| Plane | Tables | Lifecycle |
|---|---|---|
| Parse | `files`, `symbols`, `edges` | rebuilt from source, ids churn |
| Identity | `entities`, `symbol_aliases` | append + tombstone, ids never reused |
| Knowledge | `commits`, `documents`, `rules`, `memories`, … | durable |
| **Derived** | `modules`, `module_metrics`, `cochange`, … | recomputed from the three above |

So **modules are deliberately not entities.** An entity id is a promise that durable
knowledge can be attached to it forever; a module is a summary of whatever the tree looks
like today, and if the module model changes every row is thrown away and rebuilt. Making
modules entities would put a rebuildable id underneath a rule someone confirmed — the exact
mistake the plane split exists to prevent.

| Table | What it holds |
|---|---|
| `modules` | A directory at `MODULE_DEPTH` (default 2), so `src/knowledge` is a module. File count, LOC, symbol count. |
| `module_deps` | `edges` lifted from file→file to module→module, self-edges dropped. |
| `module_metrics` | Per-module commits, fix commits, authors, churn, defect density and risk over a trailing window. `window_days` is stored on the row, because churn over 90 days and churn over 365 are not the same number. |
| `cochange` | Pairwise file coupling from commit history, with `confidence` and `lift`. Keyed on paths, not file ids, since a pair is most interesting when one side has been deleted. |
| `ownership` | Recency-weighted module ownership, `share` summing to 1 per module. |
| `bug_clusters` | Recurring fix-commit themes, with `method` recording whether the grouping was semantic or keyword-based. |

**Modules are directories, not graph communities.** Louvain over `edges` finds tighter
clusters, but a community id is not stable between runs — add one file and the partition
shifts — and every metric here is only meaningful compared against the same module last
week. `src/knowledge` is stable, and it is also what people say out loud.

**Risk is the geometric mean of normalised churn and defect density**, which is the whole
point of the formula: a module that changes constantly but never breaks is busy, not risky,
and a module that breaks whenever it is touched but is touched twice a year is not urgent.
Risk needs both, and a geometric mean says that where a weighted sum would let either carry
the score alone. When a project has no recognisable fix commits at all, defect density is
zero everywhere and the score would rank everything at 0 — reading as "nothing is risky"
rather than "we cannot tell" — so it falls back to churn and reports
`risk_basis: "churn_only"`.

**Two caps, both reported rather than hidden.** Co-change skips commits touching more than
`COCHANGE_MAX_FILES` (default 50) files, because a license-header sweep over 300 files
contributes 45k pairs that say nothing about coupling and is simultaneously the largest
cost and the largest noise source; the skipped count is logged. Metrics use a
`METRICS_WINDOW_DAYS` window (default 90).

**Bug clusters are built from fix commits, not from issues** — a deliberate deviation from
the roadmap. `issues` rows do exist, but they are extracted from commit-message references
(`#123`, `PROJ-45`) and carry only a tracker, a key and a URL: no title, no body, no
labels, because nothing here talks to a tracker yet. There is no issue text to embed until
a connector exists. Clustering is greedy cosine agglomeration (τ = `BUG_CLUSTER_THRESHOLD`,
default 0.82) over `commits.message_embedding`, filled on the same embed-on-`NULL` terms as
chunks, with no training step. With no embeddings it groups by (module, most-shared term)
and stores `method: "terms"` so a keyword bucket is never presented as a semantic cluster.

Derivation runs in-process at the end of `indexProject`, inside the advisory lock it already
holds — no queue, no worker, no second service — and skips any kind whose watermark is
unchanged. The watermark is deliberately shared by all five kinds rather than tracked per
input: modules come from the parse plane and metrics from history, so per-input watermarks
would let fresh modules end up with stale metrics, or a brand-new module with none at all.

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

## Extending

- **More languages:** add a tree-sitter grammar package, map extensions in `EXT_LANG`, add node types in `parser.js`.
- **File watcher:** wrap `indexProject` with `chokidar` for auto reindex on save.
- **Feature clustering:** k-means over the embedding column (`symbols.embedding`) to auto-name feature groups.

