# Tools & APIs

Every capability is declared once in the operation registry, so the MCP tools, the CLI and
the HTTP routes below cannot drift apart.

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
| `get_modules` | The architecture as modules, with churn, defect density and a risk score — "what are the parts, and which are hot?" |
| `get_module` | One module in full: metrics, dependencies both ways, owners, largest files, recurring bugs. |
| `get_cochange` | What historically changes *with* a file — coupling by commit history rather than by imports. |
| `get_bug_clusters` | Recurring themes across fix commits — "what keeps breaking here?" |
| `compose_context` | **All of the above, fused into one answer for one task** — rules, code, docs, memory and past fixes, cited and packed into a token budget. |
| `create_reasoning_graph` | Start a new decision graph for a feature — JSON + self-contained HTML, written into the target project. |
| `update_reasoning_graph` | Patch an existing decision graph (add questions/alternatives, resolve, set risk/affected files) and re-render its HTML. |

All of these are annotated `readOnlyHint: true` except `index_project`, `remember`, and the two reasoning-graph tools, which write. Clients use the hint to decide what to auto-approve, so an unannotated read-only tool ends up behind a permission prompt that the agent's own built-in search is not.

### Server instructions

The server also returns an `instructions` string in the `initialize` handshake — the recommended workflow, what the tools are *not* for, and the indexed projects with their root paths. Clients inject it into the agent's system prompt, which makes it the one steering mechanism that needs no per-repo or per-client setup. Built in [`src/mcpInstructions.js`](../src/mcpInstructions.js) from the projects.json cache rather than the database, so a slow or unreachable DB cannot delay or break a connection; see [Installation §5](installation.md#5-what-makes-an-agent-actually-call-the-tools).

## The context API

`compose_context` is the one call that replaces firing four tools by hand. Given a task in
plain language it returns the rules governing the code involved, the code and prose that
match, what was fixed there before, and what the project has learned — every item with a
citation, packed into a token budget.

```bash
waycontext context myproject "fix the retry logic in indexProject" 2500 markdown
```

**No LLM in the hot path.** The task is parsed by regex and one dictionary lookup: quoted
phrases, backticked identifiers, path-shaped tokens, then a single
`name = ANY($tokens)` query against `symbols` and `files` to see which of the guesses the
project actually contains. Whatever didn't resolve is reported back in `understood.unresolved`
— "you mentioned `src/billing`, which this project doesn't have" is often the most useful
line in the response.

**Five channels, fused, each bounded.** Code/docs (one `search_knowledge` call, split into
two ranked lists), scoped rules, memory, history of the named paths, and **graph expansion** —
the step a pure vector retriever structurally cannot take, since the symbol a task names is
rarely the only one that must change, and its neighbours are a fact in `edges` rather than
something to hope similarity surfaces. Results are combined with weighted RRF.

**Rules bypass the fusion entirely and are exempt from the budget.** Ranking a confirmed
constraint against a search hit would mean a sufficiently good search hit could push it out,
which is exactly what the human-confirmation gate exists to prevent. If the rules alone
exceed the budget, the budget is overspent and `over_budget` says so rather than dropping
them. An agent that never saw "never edit an applied migration" will confidently edit one; a
missing code snippet only makes it search again.

**Latency comes from one place, so that is where the fix is.** The query embedding is a
network round trip and does not fit a deadline meant for Postgres — with one 400 ms budget for
everything, both embedding-dependent channels timed out on *every* cold request, degrading to
full-text on exactly the queries where semantic matching matters. It is now warmed once up
front on its own longer deadline, and `embedQuery` has an LRU cache that is **single-flight**:
the parallel channels asking for the same task text share one in-flight call rather than
making two. Warm requests land in ~450 ms; cold ones cost one provider round trip more.

`snippet: null` is a supported answer, not a bug — paths, names and citations without bodies
is what makes a privacy tier possible later, so the path is exercised now via
`{ snippets: false }`.

Every channel that misses its deadline or errors is named in `meta.degraded_channels`.
Returning less context without saying so is worse than either failure.

## The reasoning graph

Requirements, edge cases and design tradeoffs discovered mid-conversation tend to evaporate the
moment the terminal scrolls past them. `create_reasoning_graph` and `update_reasoning_graph` turn
that dialogue into a durable, git-diffable artifact instead: a decision tree — the feature at the
root, questions as branches, alternatives with pros/cons at each question, a selected answer,
affected files and a risk level — written straight into the project being worked on.

Two files per feature, under `docs/waycontext/<slug>/` (configurable via `REASONING_DIR`):
`graph.json`, the source of truth, and `reasoning.html`, a self-contained rendering of it (no
CDN, no framework, no build step — open it directly in a browser or an editor's HTML preview).
Every `update_reasoning_graph` call re-reads `graph.json` from disk, applies a batch of patch
operations atomically, and re-renders the HTML — so a developer who hand-edits the JSON between
turns has that edit picked up on the next call rather than clobbered.

```bash
waycontext reasoning-init myproject "Forgot password"
waycontext reasoning-update myproject forgot-password \
  '[{"op":"add_node","parent":"n1","type":"question","title":"Should email existence be exposed?"}]'
```

**The tools don't analyze code.** `affected_files` and risk are filled in by whoever is driving the
conversation, using `search_code`, `get_graph`, `get_modules` and the rest of the registry first —
`create_reasoning_graph`/`update_reasoning_graph` only persist and render what they're told.

## `waycontext serve` — HTTP, MCP-over-HTTP, and the web graph

```bash
waycontext serve            # http://127.0.0.1:4747
```

| Route | Purpose |
|---|---|
| `GET /health` | Liveness, version, query-cache stats. |
| `GET /v1/ops` | The operation catalogue, generated from the registry. |
| `POST /v1/ops/:name` | **Any** operation, by name or alias. |
| `POST /v1/context` | The composer. `format: "markdown"` returns text, not JSON. |
| `/mcp` | MCP over StreamableHTTP — `claude mcp add --transport http` is a one-liner. |
| `GET /` | The web knowledge graph. |

`POST /v1/ops/:name` is what makes "every surface reads the same registry" literal rather
than aspirational: the web UI and the VS Code extension both go through it, so a new
operation appears in both without either being edited. The registry is also the **allow-list** —
there is no path from HTTP to a function that isn't declared an operation, which keeps the
human-only commands (`rule confirm`, `knowledge-import`, `serve` itself) off this surface
exactly as they are off MCP. A test asserts that.

**There is no authentication.** It binds to `127.0.0.1` and *refuses* to bind anywhere else
unless `WAYCONTEXT_ALLOW_PUBLIC_BIND=1` is set, because an unauthenticated endpoint that
reads your source code must not be one config typo away from the network. Auth, rate
limiting and multi-tenancy are Team/Enterprise concerns and are deliberately absent rather
than half-present.

### Web knowledge graph

Served at `/`: modules as a force-directed graph sized by lines and coloured by risk, click
through to metrics, owners, dependencies both ways and recurring bugs, plus a search box over
`search_knowledge`. One self-contained HTML file — no bundler, no CDN, no framework, no build
step. The layout is ~40 lines of Verlet integration; a graph library would be 200 KB to draw
fewer than a hundred nodes.

### VS Code extension

`extension/`, plain JS, talking to `/v1/ops/:name`. Commands: search code/docs/memory and
jump to the result, review context for the working tree, explain the current file's module,
compose context for a task, remember something, open the graph. If the server isn't running,
the error offers to start it rather than reporting "fetch failed".

**Honest limit:** there is no headless VS Code in this repo, so `npm test` cannot exercise the
extension's UI. What *is* tested is `extension/client.js` — every request, every error path —
against a real server, plus an assertion that the commands `extension.js` implements are
exactly the ones `package.json` declares, since those two drift silently into a palette entry
that throws "command not found".

