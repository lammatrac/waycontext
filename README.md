# WayContext

MCP server that scans and indexes an entire codebase — not just listing symbols, but building a **relationship graph** (calls, imports, inheritance, WordPress hooks) plus **vector embeddings** in PostgreSQL/pgvector — so AI agents get comprehensive project context.

## What it does

- **Hybrid code search.** Postgres full-text and pgvector semantic search, fused with Reciprocal Rank Fusion — "purge cache after cron match update" finds the right function whether or not it shares words with your query.
- **A real relationship graph.** `CALLS`, `INSTANTIATES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, plus WordPress `REGISTERS_HOOK`/`FIRES_HOOK`. Ask for a symbol's blast radius before refactoring, not after.
- **Git history, with no integration to configure.** Commits, per-file churn, `.mailmap` identities and issue references, indexed straight from the repo. `who_owns` decays by recency, so it answers who to ask *today*.
- **Docs & ADRs alongside code.** `search_knowledge` ranks prose and code in one list, so an agent can answer *why* the code is shaped this way, not only where it lives.
- **Rules an agent can't invent.** Normative sentences are extracted from ADRs and fix commits as *candidates*; nothing reaches an agent until a human confirms it by CLI.
- **Engineering memory.** `remember`/`recall` so a gotcha debugged once outlives the session.
- **Architecture as modules.** Churn, defect density and a risk score per module, plus co-change coupling and recurring bug clusters.
- **One call that fuses all of it.** `compose_context` returns rules, code, docs, memory and past fixes for a task — cited, and packed into a token budget.
- **Incremental by default.** SHA-256 per file, `git diff` scoping since the last indexed commit, deleted files pruned.
- **Languages:** JavaScript, TypeScript, JSX/TSX, PHP, Python, Go.
- **Every surface reads one registry.** MCP tools, CLI subcommands and HTTP routes are generated from the same operation list, so they cannot drift apart.

## What it looks like

Ask in English, with none of the words the code uses:

```console
$ waycontext search_code waycontext "how does it avoid re-indexing files that did not change" 3
[
  { "name": "runIndex",       "path": "src/indexer.js", "matched_via": ["vector"] },
  { "name": "indexProject",   "path": "src/indexer.js", "matched_via": ["vector"] },
  { "name": "upsertFileRow",  "path": "src/indexer.js", "matched_via": ["vector"],
    "doc": "Shared by the code and doc branches: `files.hash` is what makes the
            incremental skip work…" }
]
```

Not one of those names contains "re-index", "change", or "avoid" — a grep for any of those
words finds nothing useful. Then check the blast radius before touching something:

```console
$ waycontext get_callers waycontext embed
[
  { "caller": "embedFixCommits", "path": "src/knowledge/clusters.js", "relation": "CALLS", "line": 209 },
  { "caller": "embedQuery",      "path": "src/embeddings.js",         "relation": "CALLS", "line": 125 }
]
```

Both are real output from WayContext indexing its own repository. Every one of these is
also an MCP tool, which is the point — your agent calls them itself instead of grepping.

## Quick start

**You need:** Node.js ≥ 18, and a PostgreSQL with the pgvector extension. Docker is the
easiest way to get the latter. Budget a few hundred MB for the Postgres image and a couple of
minutes for a first index; an embedding API key is optional (see the end of this section).

**1. Start a database.** The `pgvector/pgvector:pg16` image already contains the extension, so
nothing is compiled:

```bash
DB_PASS=your-password docker compose -f docker/docker-compose.yml up -d
```

Already have a PostgreSQL with pgvector? Skip this and use its connection string below.

**2. Install WayContext and point it at that database.**

```bash
npm install -g waycontext          # or run one-off with: npx waycontext <command>
export DATABASE_URL=postgres://codectx:your-password@localhost:5432/codectx
```

To avoid setting the variable every time, put it in `~/.config/waycontext/config.json`
instead:

```json
{
  "DATABASE_URL": "postgres://codectx:your-password@localhost:5432/codectx"
}
```

**3. Create the schema, then index something.**

```bash
waycontext migrate
waycontext index_project myapp /path/to/myapp
```

**4. Register the MCP server with your client.**

```bash
claude mcp add --scope user waycontext -- waycontext-mcp
```

For any other MCP client, the equivalent is `command: "waycontext-mcp"` with no arguments —
see [Installation](docs/installation.md#4-register-with-claude-code).

**5. Tell the agent which project name to pass**, by running `waycontext init` in the repo.
It writes a `## WayContext` section into that repo's `CLAUDE.md`.

### Working from a clone instead

`./install.sh` does all of the above in one step — provisions PostgreSQL + pgvector via
Docker (or apt) if it isn't already reachable, runs `npm install`, seeds `.env` with a
generated password, creates the schema, links the CLI and registers the MCP server at user
scope. It's idempotent, so it's also the upgrade path (via `./update.sh`).

```bash
git clone https://github.com/lammatrac/waycontext && cd waycontext
./install.sh
```

### Turning on semantic search

WayContext ships with `EMBEDDING_PROVIDER=none`, so everything above works with no API key
and no account: the graph tools and the full-text half of `search_code` are fully functional.

Semantic matching and `find_related` need vector embeddings, which means an API key —
WayContext doesn't run a local embedding model. Set `EMBEDDING_PROVIDER=voyage` (recommended,
`voyage-code-3` is trained on code) or `openai`, plus the matching key. It's worth it if you
want natural-language queries: measured recall@10 is **0.66** with embeddings against **0.00**
without, on this repo's own commit-replay harness. Indexing this repo costs well under a cent.
See [Retrieval quality](docs/evaluation.md) and
[token usage & cost](docs/installation.md#tracking-token-usage--cost).

Full setup, per-OS notes and configuration: [Installation & configuration](docs/installation.md).
Something broken? [Troubleshooting](docs/troubleshooting.md) is organised by symptom.

## Documentation

| Document | What's in it |
|---|---|
| [Installation & configuration](docs/installation.md) | Database setup (Docker/apt), CLI, tab completion, MCP registration, embedding providers, token usage & cost |
| [Troubleshooting](docs/troubleshooting.md) | Install, update, indexing, search and MCP problems, by symptom |
| [Architecture & data model](docs/architecture.md) | How the pieces fit, every table explained, the four planes, stable symbol identity |
| [Algorithms & concepts](docs/algorithms.md) | AST parsing, SHA-256 hashing, BFS, embeddings & cosine distance, HNSW, `tsvector`, RRF — and how `search_code` works |
| [Tools & APIs](docs/api.md) | The MCP tool list, the context API, `waycontext serve`, the web graph, the VS Code extension |
| [Knowledge: rules, memory, docs & history](docs/knowledge.md) | Rule extraction and the human-confirmation gate, engineering memory, ADR ingestion, git history |
| [Retrieval quality](docs/evaluation.md) | The `eval/` harness — replaying real commits as labelled data |
| [Changelog](CHANGELOG.md) | Release history |
| [Contributing](CONTRIBUTING.md) | Development setup and conventions |
| [Security policy](SECURITY.md) | Reporting a vulnerability, and what's deliberately out of scope |

## Suggested agent workflow (e.g. in CLAUDE.md)

```
Before modifying code:
1. project_overview → orient
2. search_code with the task description → candidate symbols
3. get_graph / get_callers on the target → impact analysis
4. get_symbol → read actual source
Re-run index_project after committing changes.
```

`waycontext init` writes this as a `## WayContext` section into the project's `CLAUDE.md`,
including the project name to pass to the tools. For a stronger push there's an opt-in
`PreToolUse` hook — see [Installation](docs/installation.md#5-optional-nudge-agents-toward-the-mcp).

## Notes & limits

- Call resolution is name-based (exact + `Class::method` suffix), not type-inferred — dynamic calls (`$fn()`, `call_user_func`) stay as unresolved `dst_name` edges, which is still useful signal.
- Symbol bodies are truncated at 6 KB for storage/embedding.
- Files > 1 MB skipped (configurable via `MAX_FILE_SIZE`).
- `waycontext serve` has **no authentication** and binds to `127.0.0.1` only. Auth, rate limiting and multi-tenancy are deliberately absent rather than half-present.

## Changes

- 2026-08-05: Fixed two documentation drifts found in a command-list consistency audit:
  `docs/architecture.md` still credited `src/server.js` with the MCP tool-registration
  loop that was extracted into `src/mcpServer.js` back in Phase 5; `docs/installation.md`'s
  CLI section only showed 6 of the 22 registry operations. Every code-level surface
  (CLI switch, completion table, MCP registration, HTTP routes, hook script, VS Code
  extension) was already covered by parity tests and found consistent — only hand-written
  markdown was out of sync.

- 2026-08-05: Bumped `@modelcontextprotocol/sdk` to 1.30.0 and applied `npm audit fix`
  (including a major `@hono/node-server` bump to 2.1.0), resolving all 4 known
  vulnerabilities in transitive dependencies. Full test suite verified green.

- 2026-08-04: Call resolution is now scope-aware. A bare-identifier call/`new` matching one
  of the enclosing function's own parameters (e.g. `function derive(project, log = () => {})`
  calling `log(...)`) is no longer treated as a call to a same-named project symbol elsewhere
  — it previously invented phantom module dependencies in `get_module`'s architecture graph.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The name "WayContext" and the
WayContext logo are trademarks and are not covered by that license; see
[TRADEMARK.md](TRADEMARK.md).
