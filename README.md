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

**You need:** Node.js ≥ 20, and a PostgreSQL with the pgvector extension. Docker is the
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

**5. Point the repo's agents at it**, by running `waycontext init` in the repo. It writes a
`## WayContext` section — the project name plus the workflow to follow — into `CLAUDE.md`,
`AGENTS.md` and, where applicable, `.github/copilot-instructions.md`, and registers the
server in `.vscode/mcp.json` for Copilot. See
[Getting agents to actually use it](#getting-agents-to-actually-use-it).

That section is also what the CLI reads to work out which project you mean, so once a
repo has been through `init` you can drop the `<project>` argument entirely:

```bash
cd /path/to/myapp
waycontext index                       # same as: waycontext index myapp /path/to/myapp
waycontext search "purge cache after status update"
```

Naming a project explicitly still wins, and if nothing on disk settles it the CLI asks —
or, when it isn't attached to a terminal, exits with the list of indexed projects rather
than hanging.

### Working from a clone instead

`./install.sh` does all of the above in one step — provisions PostgreSQL + pgvector via
Docker (or apt) if it isn't already reachable, runs `npm install`, seeds `.env` with a
generated password, creates the schema, links the CLI and registers the MCP server at user
scope. It's idempotent, so it's also the upgrade path (via `./update.sh`).

It also ensures the local WayContext HTTP service is running in the background, so
review URLs are immediately openable without manually running `waycontext serve`.

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

## Getting agents to actually use it

Registering an MCP server makes its tools *available*; it doesn't make an agent prefer them
over its own built-in search. WayContext pushes on that in three places, weakest to
strongest:

**1. The server tells every client, automatically.** WayContext sends MCP `instructions` in
the `initialize` response — the workflow below, what the tools are *not* for, and the list of
indexed projects with their root paths. Clients inject this into the agent's system prompt, so
it works in Claude Code, Copilot and Cursor alike with no setup at all. Including the project
list matters more than it looks: every tool takes a required `project` argument, and a tool
that costs a `list_projects` round-trip before its first real query loses to a grep that costs
one call.

```
1. project_overview → orient
2. search_code with the task description → candidate symbols
3. get_graph / get_callers on the target → blast radius
4. get_symbol → read actual source
Re-run index_project after committing changes.
```

**2. `waycontext init` writes it into the repo**, as a `## WayContext` section stating that
workflow, the project name, and where grep is still the right answer. It writes every
agent-instruction file the repo's clients read, not just `CLAUDE.md`:

| File | Read by |
|---|---|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Copilot, Cursor, Codex, Gemini CLI, Amp |
| `.github/copilot-instructions.md` | GitHub Copilot (only if the repo already has a `.github/`; `--all` forces it) |
| `.vscode/mcp.json` | VS Code / Copilot — *registration*, not instruction. `install.sh` only registers with Claude Code, so without this Copilot never connects to the server in the first place. |

Re-running is idempotent, existing content is preserved, and each file is confirmed
separately. `waycontext init <name> --yes` is the non-interactive form.

**3. An opt-in `PreToolUse` hook** intercepts greps in an indexed project and redirects —
Claude Code only, three escalating modes. See
[Installation](docs/installation.md#5-what-makes-an-agent-actually-call-the-tools).

## Notes & limits

- Call resolution is name-based (exact + `Class::method` suffix), not type-inferred — dynamic calls (`$fn()`, `call_user_func`) stay as unresolved `dst_name` edges, which is still useful signal.
- Symbol bodies are truncated at 6 KB for storage/embedding.
- Files > 1 MB skipped (configurable via `MAX_FILE_SIZE`).
- `waycontext serve` has **no authentication** and binds to `127.0.0.1` only. Auth, rate limiting and multi-tenancy are deliberately absent rather than half-present.

## Changes

- 2026-08-08: Added automatic local background service management for `waycontext serve` workflows (`service ensure|status|stop`, install/update/postinstall auto-ensure, duplicate-start protection, version-aware restart, and worker recovery), integrated reasoning review hosting at `GET /reviews/:project/:slug`, and returned `review_url` from reasoning graph create/update responses so CLI/MCP/agent flows can open reviews directly.

- 2026-08-08: Hardened reasoning review auto-open on WSL and Linux. The
  opener now detects WSL, translates Linux paths via `wslpath -w`, launches
  through `cmd.exe /c start ""`, and falls back to
  `/mnt/c/Windows/System32/cmd.exe` when `cmd.exe` is missing on PATH. Added
  focused unit coverage in `test/reasoning.open.test.js` for macOS/Windows/
  Linux/WSL launch resolution and fallback behavior.

- 2026-08-11: `update_reasoning_graph` no longer auto-opens a browser tab on
  every call (it re-runs repeatedly during a session, unlike the one-time
  `create_reasoning_graph` init call, which still auto-opens as before).
  Updated the tool description and test coverage accordingly.

- 2026-08-08: Upgraded reasoning graphs into a reviewer-first Decision Review UI
  and made review auto-open default-on. `create_reasoning_graph` /
  `update_reasoning_graph` now render an executive-summary layout (decision graph,
  impact map, risks/conflicts, evidence, approval panel) from `graph.json` into
  `waycontext-review.html` (while still mirroring `reasoning.html` for backward
  compatibility). Nodes gained explicit review semantics (`verified`, `assumed`,
  `inferred`, `conflict`, `unknown`), confidence scores, and evidence lines,
  with corresponding patch ops (`set_review`, `set_confidence`, `set_evidence`).
  Auto-open now defaults to enabled whenever `REASONING_AUTO_OPEN` is unset,
  including first-run and MCP-triggered flows; set `REASONING_AUTO_OPEN=0` to
  disable.

- 2026-08-08: The CLI now works out which project you mean instead of making you
  retype it. Every command whose first argument is `<project>` can omit it inside a
  repo that has been through `waycontext init`: the name is read back out of the
  `## WayContext` section in `CLAUDE.md` (or `AGENTS.md`, or the Copilot file),
  searching upward from the working directory and stopping at the git root so the
  walk can't escape into a parent checkout. `waycontext index` needs no arguments at
  all — `index_project` declares `rootDefault: "path"` in the registry and the
  detected repo root fills it. Omitted arguments are filled from the right before the
  left, which is what makes `waycontext index my-app` still mean the *project*
  my-app rather than a path called that. Falling back: sole indexed project, then a
  prompt identical to init's — with a `(y/N)` offer to write the answer into the
  repo's agent files so it's asked once — then, with no TTY, an error naming the
  indexed projects, because an agent or CI job must fail rather than block on a
  question nobody can answer. Resolution is skipped entirely when the arguments are
  already there, reported on stderr so piped JSON stays clean, and left off the MCP
  surface, where there is no working directory to read.
- 2026-08-08: Made agents actually reach for the tools instead of falling back to
  their own search. The server now sends MCP `instructions` in the `initialize`
  handshake — the recommended workflow, what the tools are *not* for, and the
  indexed projects with their root paths — which every client injects into the
  agent's system prompt, so it works in Claude Code, Copilot and Cursor with no
  setup. Including the project list removes a `list_projects` round-trip that a
  required `project` argument otherwise forced before the first real query. Tools
  are annotated `readOnlyHint` (all but the four that write): clients auto-approve
  read-only tools, so without it `search_code` raised a permission prompt while the
  agent's built-in `Grep` was pre-approved. `waycontext init` now writes a
  *directive* section — the 4-step workflow and where grep is still correct, not
  just the project name — into `AGENTS.md` and `.github/copilot-instructions.md`
  alongside `CLAUDE.md`, and registers the server in `.vscode/mcp.json`, since
  `install.sh` only ever registered it with Claude Code. Two fixes found on the way:
  `upsertSection` appended a newline on every run, so init grew its files forever
  (invisible with one target, not with four); and where two indexed projects share a
  root — a stale trial index beside the real one — the instructions name both and
  say to ask rather than guessing one into the system prompt as fact. The dead
  `buildGlobalSection`/`upsertGlobalSection` pair is gone, its content superseded by
  `instructions`; `removeGlobalSection` stays so uninstall can still clean up
  machines older versions wrote to.

- 2026-08-05: Added a new "Support WayContext" section before License, including
  donation messaging, PayPal support options, and a clarification that Team Edition
  remains free for individuals/startups while Enterprise Edition provides advanced
  features and commercial support.

- 2026-08-05: Added reasoning/decision graphs. `create_reasoning_graph` and
  `update_reasoning_graph` write a git-trackable `graph.json` plus a self-contained
  `waycontext-review.html` (questions, alternatives with pros/cons, a selected answer, risk,
  affected files) into a target project's own `docs/waycontext/<slug>/`, so a feature's
  requirements and edge-case discovery survive past the chat that produced them.
  `graph.json` is the source of truth — every `update_reasoning_graph` call re-reads it
  from disk and re-renders the HTML, so a hand-edit between calls is respected rather
  than overwritten. `waycontext init`'s injected `CLAUDE.md` section now also tells
  Claude to render a reasoning graph before presenting a spec or implementation plan for
  review, instead of asking the developer to read it as markdown.

- 2026-08-05: Fixed two documentation drifts found in a command-list consistency audit:
  `docs/architecture.md` still credited `src/server.js` with the MCP tool-registration
  loop that was extracted into `src/mcpServer.js` back in Phase 5; `docs/installation.md`'s
  CLI section only showed 6 of the 22 registry operations. Every code-level surface
  (CLI switch, completion table, MCP registration, HTTP routes, hook script, VS Code
  extension) was already covered by parity tests and found consistent — only hand-written
  markdown was out of sync.

- 2026-08-05: Dropped Node 18 support (`engines.node` now `>=20`; CI matrix now 20/22).
  The `@hono/node-server` 2.1.0 bump below turned out to require Node >=20 across its
  entire 2.x line — there is no version that both patches its CVE and runs on Node 18 —
  and under real Node 18 its Node→Fetch request bridging (now used by
  `@modelcontextprotocol/sdk`'s HTTP transport) throws `ReferenceError: crypto is not
  defined`, which surfaced as 3 failing MCP-over-HTTP tests on CI's Node 18 leg only.
  Node 18 reached EOL in April 2025.

- 2026-08-05: Bumped `@modelcontextprotocol/sdk` to 1.30.0 and applied `npm audit fix`
  (including a major `@hono/node-server` bump to 2.1.0), resolving all 4 known
  vulnerabilities in transitive dependencies. Full test suite verified green.

- 2026-08-04: Call resolution is now scope-aware. A bare-identifier call/`new` matching one
  of the enclosing function's own parameters (e.g. `function derive(project, log = () => {})`
  calling `log(...)`) is no longer treated as a call to a same-named project symbol elsewhere
  — it previously invented phantom module dependencies in `get_module`'s architecture graph.

## ❤️ Support WayContext

WayContext is free for individuals and startups, and we are committed to keeping it that way.

If WayContext has helped you or your team, consider supporting its continued development. Your contribution helps fund new features, bug fixes, documentation, infrastructure, and long-term maintenance.

### Donate with PayPal

[![Donate $5](https://img.shields.io/badge/☕-$5-blue?style=for-the-badge)](https://paypal.me/lammatrac/5)
[![Donate $10](https://img.shields.io/badge/🚀-$10-green?style=for-the-badge)](https://paypal.me/lammatrac/10)
[![Donate $15](https://img.shields.io/badge/💙-$15-purple?style=for-the-badge)](https://paypal.me/lammatrac/15)
[![Custom Amount](https://img.shields.io/badge/Donate-Custom-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/lammatrac)

Every contribution, no matter the size, is greatly appreciated.

**WayContext Team Edition** will always be free for individuals and startups.

For organizations that require advanced capabilities, dedicated support, and commercial licensing, **WayContext Enterprise Edition** is available.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The name "WayContext" and the
WayContext logo are trademarks and are not covered by that license; see
[TRADEMARK.md](TRADEMARK.md).
