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

## Quick start

```bash
npm install -g waycontext            # or run one-off with: npx waycontext <command>
waycontext migrate                   # create the schema
waycontext index_project myapp /path/to/myapp
```

This needs a PostgreSQL with pgvector. The fastest way to get one:

```bash
DB_PASS=your-password docker compose -f docker/docker-compose.yml up -d
```

Point WayContext at it through the environment or `~/.config/waycontext/config.json`:

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

Working from a clone instead? `./install.sh` does all of the above — installs PostgreSQL +
pgvector if needed, runs `npm install`, seeds `.env`, initializes the schema, links the CLI
and registers the MCP server at user scope. It's idempotent, so it's also the upgrade path
(via `./update.sh`).

**Embeddings are optional.** With `EMBEDDING_PROVIDER=none` the graph tools and the full-text
half of search work with no API key — you lose semantic matching and `find_related`. Note
that natural-language queries degrade badly in that mode; see
[Retrieval quality](docs/evaluation.md).

Full setup, per-OS notes and configuration: [Installation & configuration](docs/installation.md).

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
- **Name-based resolution can invent a module dependency.** There is no scope analysis, so a call to a *parameter* resolves to whatever project function shares its name. In this repo every `log(...)` inside `src/knowledge` is calling an injected callback, but the only declared `log` is in `extension/extension.js` — so `get_module src/knowledge` reports a dependency on `extension` that does not exist. Harmless for `search_code`; misleading in the architecture graph, which is where it became visible. The fix is scope-aware resolution (a call matching a parameter of the calling symbol should stay unresolved), not a filter in the graph layer.
- Symbol bodies are truncated at 6 KB for storage/embedding.
- Files > 1 MB skipped (configurable via `MAX_FILE_SIZE`).
- `waycontext serve` has **no authentication** and binds to `127.0.0.1` only. Auth, rate limiting and multi-tenancy are deliberately absent rather than half-present.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The name "WayContext" and the
WayContext logo are trademarks and are not covered by that license; see
[TRADEMARK.md](TRADEMARK.md).
