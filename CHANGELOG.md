# Changelog

Newest first. Dates are the day the change landed.

## 2026-08-05 — v0.3.2: scope-aware call resolution

Call/instantiation resolution was purely name-based, with no notion of scope: a bare
identifier resolved to whatever project-wide symbol shared its name, even when that
identifier was actually one of the calling function's own parameters.

- **A call to a same-named parameter no longer invents a module dependency.**
  `function derive(project, log = () => {}) { log(...) }` recorded a `CALLS` edge to
  the unrelated top-level `log` elsewhere in the project — harmless for `search_code`,
  but it fabricated a `depends_on` entry in `get_module`'s architecture graph. The
  parser now tracks each function/method's own parameter names (including defaults,
  destructuring, and rest/spread across JS/TS, PHP, Python and Go) and leaves a
  matching bare-identifier call or `new` unresolved instead of guessing.

## 2026-08-04 — v0.3.1: `install.sh` on a fresh clone

v0.3.0 added a CI job that **executes** `install.sh` rather than only parsing it. On its
first run it found two bugs that meant the fresh-clone path had never worked — invisible
until then because the only way it had ever been exercised was a re-run on a machine that
already had a `.env` and a cached Docker image.

- **`sed` exits 2 when it cannot read its input.** `DB_PASS="$(sed -n … .env 2>/dev/null |
  head -1)"` hid the *message* but not the *status*; `set -o pipefail` carried it past
  `head` and `set -e` aborted. So with no `.env` — the definition of a fresh clone, and the
  only case the script is really for — it died on that line before doing anything. Guarded
  with `[ -f .env ]`; a re-run still reuses an existing password rather than regenerating.
- **The database readiness check was a 60×1s `pg_isready` loop.** On a cold runner, pulling
  a ~400 MB image and running `initdb` on slow disk routinely takes longer than that.
  Replaced with `docker compose up -d --wait`, which uses the healthcheck the compose file
  already defined, with a 300s budget and a fallback for compose versions predating
  `--wait-timeout`.
- **The timeout destroyed the only evidence of itself.** It printed "check: `docker compose
  … logs`" and exited, which on a CI box that is then discarded is unfollowable advice. It
  now dumps `ps` and `logs --tail=60` inline.
- **That advice would not have worked anyway.** `DB_PASS` was scoped to the `up` command
  alone, and the compose file declares `POSTGRES_PASSWORD: ${DB_PASS:?…}`, so `ps` and
  `logs` both failed with `required variable DB_PASS is missing`. Now exported for the whole
  section — which is also what makes the new diagnostics work.

No changes outside `install.sh`. Nothing in the npm package's own code path is affected:
`install.sh` is the clone workflow, and `npm install -g waycontext` never runs it.

## 2026-08-04 — v0.3.0: the first npm release

First version published to npm, and a pass over everything a first-time user hits
before they get to the interesting parts.

**The install path actually worked end to end for the first time.** `install.sh`
had three bugs that only a fresh machine would find, because a re-run on a working
install takes none of those branches:

- It called `node` five lines **above** the check for whether Node exists, so a
  machine without Node died on bash's own `node: command not found` and the
  friendly "Node.js >= 18 required" message could never print for the one audience
  it was written for.
- `sed -i` is a GNU spelling. BSD `sed` (macOS) reads the next argument as a backup
  suffix, so writing `DATABASE_URL` into a new `.env` failed and `set -e` aborted
  the whole install — on the fresh-install path only, which is exactly the one a
  first-time macOS user takes. The docs had claimed macOS support since Docker
  became the preferred database path.
- A missing `claude` binary was treated as a fatal error, after every step that
  mattered had already succeeded. Cursor, Windsurf, Zed and plain-`.mcp.json`
  users were told their install had failed when it hadn't. It's now a warning that
  prints both the `claude mcp add` line and an `.mcp.json` snippet.

It also no longer falls through to `init-db` after warning that no database could
be provisioned, and CI now **executes** `install.sh` rather than only parsing it —
including a re-run, to prove the idempotency claim it makes about itself.

**Errors explain themselves.** The CLI was `main().catch(e => console.error(e))`,
so the most common first-run situation there is — no database yet — printed a
`pg-pool` stack trace, and exited **0**. Expected failures now map to one line and
a remedy (`src/friendlyError.js`), exit non-zero, and keep frames behind
`--debug`/`WAYCONTEXT_DEBUG=1`. Covered: connection refused, bad credentials
(including the `waycontext-pgdata` volume keeping its original password), missing
database, missing schema, absent pgvector, and a rejected embedding key. The
connection-refused message names the URL it tried **and where that URL came from**
— environment, which `.env`, the config file, or the built-in default — because the
usual cause is a value the user didn't know was set. Passwords are redacted.

**`--help` and `-h` work.** They printed `Unknown command: --help` and exited
non-zero, while `--version` and `-v` had always been accepted.

**`help` is grouped, and describes what things do.** A newcomer's first four lines
used to be `init-db`, `migrate` and `backfill-identity`. It now opens with
`index_project` and `search_code` under six ordered sections, each registry
operation carries a one-line gloss, and `waycontext help <command>` prints the full
description an MCP client sees — previously unreachable from a terminal. Fixed a
padding overflow that rendered `search_knowledge <project> <query> [limit](alias:
knowledge)` with no separating space; the threshold is now derived from the actual
string length instead of a hand-set flag.

**`EMBEDDING_PROVIDER` ships as `none`.** `.env.example` set `voyage` with an empty
`VOYAGE_API_KEY`, and `install.sh` copied it verbatim — the one combination that
fails, and it failed part-way through a first index with an API `401`. The default
now works with no key and no account, and a provider set without its key fails
immediately with a configuration message rather than a provider error.

**A name that doesn't resolve says so.** `get_callers` on a misspelled symbol
returned `[]`, indistinguishable from "nothing calls this" — the difference between
"safe to change" and "you typed it wrong", and the agent consumers will act on
either. `get_symbol`, `get_callers`, `get_callees`, `get_graph`, `find_related` and
`get_file_outline` now share one contract and one message. A real symbol with no
callers still returns `[]`, which is the distinction that matters.

**Smaller fixes.**

- Indexing a repo of unsupported languages logged `Found 0 source files` and
  reported success; it now says so and lists the extensions it does parse, derived
  from the parser's own table.
- `get_rules <project> <bad-target>` ended with "omit the target for project-wide
  **history**", because `resolveTarget` is shared with the history queries.
- `docs/` and `CHANGELOG.md` were missing from the npm tarball, while the README is
  essentially a table of links into them. Doc images now use absolute URLs, since
  `src/images/` stays excluded (3.5 MB). Note that `files` **overrides**
  `.gitignore` for any path it lists, so adding `docs/` also started shipping the
  gitignored `docs/superpowers/**` planning documents — now excluded explicitly,
  and CI asserts every file in the tarball is tracked in git, which is the only
  form of that check that catches the next instance of it.
- `update.sh` recognises a global npm install instead of erroring "re-clone
  instead", and its header comment no longer claims to touch `~/.claude`.
- `.gitignore` had `.sql` and `.bk` with no `*`, matching nothing. SQL is scoped to
  the repo root: a bare `*.sql` would silently ignore every new migration.
- Added `SECURITY.md` (with what's deliberately out of scope), `CODE_OF_CONDUCT.md`,
  issue and PR templates, and an `author` field — `CONTRIBUTING.md` had pointed at
  a maintainer that `package.json` didn't list, and promised a CLA bot that didn't
  exist.
- Two drift guards for the gaps CI didn't cover: the search hook's five hardcoded
  tool names are now checked against the registry, and `test/http.test.js`'s
  "lists the same tools as the registry" test now actually calls `tools/list` and
  compares — it previously only ran `initialize` and grepped for `"serverInfo"`.
- Stale `codecontext` naming in `CONTRIBUTING.md` and `.env.example`.

## 2026-08-04 — tab completion for the CLI

- **`waycontext completion install`** writes a bash completion script that completes
  subcommands and aliases, sub-verbs, flags, and indexed project names. Opt-in, like
  the search hook; `waycontext uninstall` removes it; `install.sh` refreshes it on
  upgrade only if you already have it.
- **No `.bashrc` edit.** The file goes in the XDG bash-completion directory, which
  the completion loader searches by command name.
- **No node process on the Tab hot path.** Spawning the CLI costs 0.10–0.14 s, which
  is past the point where Tab stops feeling instant, so code-derived words are baked
  into the script at generation time and project names are read from the cache the
  search hook already maintains.
- **The hand-written CLI commands now live in one table** (`src/completion.js`)
  that `buildHelp()` also reads. They used to be literal strings inside `buildHelp()`,
  separate from the switch implementing them; completion would have made that a third
  copy. A test asserts every switch case has a completion entry.
- Known gap: `rule` completes its sub-verbs and `--json` but not its project argument
  — the slot differs by sub-verb (`candidates [project]` vs `confirm <id> [project]`).
  zsh is not supported.

## 2026-08-04 — naming left over from the rename

- **`waycontext help`** described `init` as writing "the CLAUDE.md Code Context MCP section".
  The section it actually writes has been `## WayContext` since the rename.
- **`waycontext uninstall`** reported removing "the Code Context MCP Workflow section" even
  when it had removed one headed `## WayContext Workflow` — `GLOBAL_SECTION_RE` matches
  either name, but the message hardcoded the old one.
- **`check-update.sh` notified as `code-context-mcp`**, in both the message body and the
  `notify-send` title — the one stale name users actually saw on a regular schedule.
- **This repo's own `CLAUDE.md`** still carried the pre-rename `## Code Context MCP` heading
  and told agents to use "`code-context` tools", which stopped existing once the duplicate
  MCP registration was removed. Now `## WayContext`, which `SECTION_RE` still matches, so
  `waycontext init` continues to migrate it in place rather than appending a second section.

Output strings and docs only; no behaviour changed. The remaining `code-context` references
are deliberate: the `code-context-mcp` bin alias, the heading regexes that recognise both
names, and `install.sh` removing the pre-v0.2.0 global link.

## 2026-08-04 — documentation split

- **README reduced from 1210 lines to ~100.** It had grown to cover everything from apt
  commands to the RRF formula, so nothing in it was findable. It now carries a feature
  summary (which it never had — it opened straight into `## Setup`), a quick start, and an
  index of everything else.
- **Reference material moved to `docs/`**, joining the existing `docs/superpowers/` rather
  than creating a second docs tree: `installation.md`, `troubleshooting.md`,
  `architecture.md`, `algorithms.md`, `api.md`, `knowledge.md`, `evaluation.md`.
- **This changelog moved to `CHANGELOG.md`** at the repo root — it was 23% of the README, and
  root is where npm links it and where contributors expect to append.
- **`docs/troubleshooting.md` is new writing**, not a move: the failure modes that were
  scattered as asides through the old README, reorganised symptom-first — the `ON CONFLICT`
  error after updating without restarting the MCP client, pgvector missing on older Ubuntu,
  port conflicts, platforms with no tree-sitter prebuild, `EMBEDDING_DIM` changes, docs
  invisible to an incremental reindex, the globally-installed `deny`-mode hook from older
  installers, and why natural-language search returns nothing with `EMBEDDING_PROVIDER=none`.
- Verified by diffing every body line of the old README against the new set: the only lines
  that changed are the cross-file links and image paths that had to be rewritten.

## 2026-08-04 — CI test discovery

- **`npm test` no longer depends on `globstar`.** npm runs scripts through `sh`, where `**` is
  not recursive, so `test/**/*.test.js` degraded to `test/*/*.test.js`, matched nothing, and
  the unexpanded pattern reached Node as a literal path — green locally (bash with `globstar`),
  failing in CI. Now `test/*.test.js`, which matches all 42 files. Deliberately not
  `node --test test/`: that also treats `test/helpers/*.js` as test files, and two of them open
  a pg pool at import time.

## 2026-08-03 — Phases 5 & 6: context API, HTTP, web graph, VS Code

- **`compose_context`** (CLI: `context`) — one call that assembles rules, code, docs, memory
  and past fixes for a task, cited, with rules exempt from the token budget. See
  [The context API](docs/api.md#the-context-api). Task parsing is regex plus one dictionary query; there
  is no LLM in the hot path.
- **`waycontext serve`** — `/health`, `/v1/ops`, `POST /v1/ops/:name`, `POST /v1/context`,
  `/mcp` over StreamableHTTP, and the web UI at `/`. Localhost-only and it refuses to bind
  elsewhere without an explicit opt-in, because it has no authentication.
- **Web knowledge graph** and a **VS Code extension**, both going through
  `POST /v1/ops/:name`, so neither hardcodes a schema and a new operation reaches both for
  free.
- **Extracted `buildMcpServer()`** from `src/server.js` so stdio and HTTP register tools from
  one loop. Two copies would drift the moment one transport gained a tool the other didn't.
- **Query-embedding cache, single-flight.** The composer's channels run in parallel and two of
  them embed the *same* task text at the same instant, so caching only resolved values would
  still make two API calls; the in-flight promise is what's cached. Failures are never cached,
  and the key includes provider, model and dimension so switching provider can't serve vectors
  from the wrong space.
- **Fixed the composer degrading on every cold request.** One 400 ms deadline for all channels
  meant both embedding-dependent ones always timed out — a network round trip does not fit a
  budget meant for Postgres. The query embedding is now warmed up front on its own deadline
  and the channels' deadline governs database time only.
- **Fixed two parser bugs found by its own tests:** identifiers were being searched a second
  time as plain words, because `consumed` was compared case-sensitively against lowercased
  terms; and "and/or" was parsed as a file path, which also stripped both words out of the
  search terms. A slash-joined candidate whose every segment is an English function word is
  now rejected.
- **Fixed clustering keyed on the wrong thing:** it checked whether the embedding provider was
  switched on rather than whether vectors existed, so querying an already-embedded database
  with `EMBEDDING_PROVIDER=none` silently dropped to keyword buckets while semantic vectors
  sat unused.
- **`waycontext <op>` prints text as text.** `compose_context` with `format: markdown` was
  being JSON-encoded into one escaped line, which defeats the point of a paste-ready format.

## 2026-08-03 — Phase 4: derived intelligence

- **A fourth, disposable plane**: `modules`, `module_deps`, `module_metrics`, `cochange`,
  `ownership` and `bug_clusters`, recomputed from the three planes below them and skipped
  entirely when their inputs haven't moved. Modules are directories, not graph communities,
  because a community id isn't stable between runs and every metric here is a comparison
  against the same module last week. See [The derived plane](docs/architecture.md#the-derived-plane).
- **Four new tools**: `get_modules`, `get_module`, `get_cochange`, `get_bug_clusters`
  (CLI: `modules`, `module`, `cochange`, `bugs`).
- **Derivation runs inside the index run's existing advisory lock** — no queue, no worker,
  no second service — and after the `last_indexed_sha` update, since that sha *is* the
  watermark. A failed derivation deliberately doesn't record its watermark, so the next run
  retries it; the same rule `last_indexed_sha` already follows.
- **Fixed `is_fix` counting `feat:` commits as defects.** The classifier matched "fix"
  anywhere in the subject, so "feat: assemble review context from rules and past fixes" was
  a defect — tolerable while it only filtered `get_history`, not tolerable once
  `defect_density` divides by it. It now requires conventional-commit type position (however
  the subject is prefixed) or the first word of the subject once a ticket id or `Name - `
  prefix is stripped. Measured on this repo: 11 fix commits → 8, all genuine.
  `0010_reclassify_fix_commits.sql` clears `last_history_sha` and `derived_state` so the
  next index re-reads the log and recomputes both — one extra history pass per project, once.
- **Fixed labelling picking the word a cluster is *not* about.** TF-IDF is maximised by a
  term appearing in exactly one document, so for two commits both about idempotency, the
  words unique to each outscored the word they shared. Labels now weight in-cluster share
  against out-of-cluster share, and bucketing (embeddings off) deliberately uses the
  opposite measure — the most-shared term — since choosing a bucket by rarity splits exactly
  the commits that belong together.
- **Clustering keys on whether vectors exist, not on whether the provider is switched on**,
  so setting `EMBEDDING_PROVIDER=none` against an already-embedded database doesn't silently
  drop to keyword buckets while semantic vectors sit unused.

## 2026-08-03 — indexing robustness

- **A stray NUL byte no longer fails a file — permanently.** Postgres `text` cannot hold
  `0x00` at all, so one such byte threw on insert and failed the whole file; and because a
  failed file deliberately holds `last_indexed_sha` back, every later incremental run
  recomputed the same diff and failed on the same file forever. `indexProject` now strips
  NULs at the read boundary, before hashing, so the stored hash describes what was actually
  stored and a re-run skips the file. Found by dogfooding: `src/knowledge/rules.js` itself
  contained one, so the rule extractor was the one file in this repo its own indexer could
  not index.

## 2026-08-03 — Phase 3: rules & engineering memory

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

## 2026-08-03 — Phase 2: docs & ADR ingestion

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
  note under [Docs & ADRs](docs/knowledge.md#docs--adrs-search_knowledge).
- **Doc→code links are conservative.** A backticked identifier matching exactly one symbol
  becomes `entity_links(relation='MENTIONS')`; ambiguous names are left unlinked, as the
  namespaced-edge resolver already does. Path references stay in `documents.mentions` under
  a GIN index rather than fanning out to every symbol in the file.

## 2026-08-03 — Phase 1: identity + git history

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

## 2026-08-02 — v0.2.0

**Breaking: the package, CLI and MCP server are all called `waycontext` now.** The package was `code-context-mcp`, the CLI was `codecontext`, and the server identified itself as `code-context` while `install.sh` registered it as `waycontext` — so clients saw two names for one server, and the search hook's hardcoded `mcp__code-context__*` tool names never matched anything. The name is now read from `package.json` in one place so it can't drift again. The old `codecontext` and `code-context-mcp` binaries remain as aliases for one release; `install.sh` removes the pre-v0.2.0 global link, which otherwise kept ownership of the `codecontext` binary name. **Existing installs need `claude mcp remove --scope user <old-name>` if they registered under anything other than `waycontext`, and a Claude Code restart.** The `## Code Context MCP` heading in project `CLAUDE.md` files became `## WayContext`; both are recognised, so `waycontext init` migrates an existing section in place rather than appending a second one.

- Published to npm as `waycontext`, so `npx waycontext <command>` and `npm install -g waycontext` work. Verified by packing the tarball, installing it into a throwaway prefix and running it from outside the repo: the CLI, the aliases, the MCP server binary, migration discovery and `~/.config/waycontext/config.json` resolution all work with no `.env` anywhere near the install — the case the old `__dirname`-based config lookup could never have handled.
- Cut the tarball from 2.8 MB to 63 kB by excluding the three README diagrams, which were 97% of it and were being downloaded on every `npx` run. Setting `repository` in `package.json` means npm still renders them, resolving the relative paths against GitHub.
- Added `waycontext version`.
- Added **Python** (`.py`, `.pyi`) and **Go** (`.go`) parsing. Python contributes classes, methods (including decorated ones, which wrap the definition they annotate), functions, base classes, and both import forms; Go contributes functions, structs, interfaces, imports in either syntax, composite literals as instantiation, and methods named after their receiver type (`Server::Handle`) to match how methods are named in every other language here. Pinned to `tree-sitter-python@0.23.4` / `tree-sitter-go@0.23.4`, the newest releases whose peer dependency still matches the tree-sitter core in use — the current 0.25 releases require a core bump, and forcing them with `--legacy-peer-deps` risks an N-API ABI mismatch that fails as a segfault rather than an error. Both ship prebuilt binaries for six platforms, so they add no build requirement; the CI guard now covers them too.
- **Known gap, unchanged by the above:** a call written `this.method()` / `self.method()` / `obj.method()` records its callee verbatim, so it doesn't resolve to the method it targets. 606,671 of 1,542,104 unresolved edges in a local index are of this shape, 87,560 of them specifically `this.*`/`self.*`. This has always applied to JavaScript and TypeScript — PHP avoids it because member calls are parsed to the bare method name — and Python inherits it, where it matters more because methods are almost always reached through `self`. Worth fixing next in the parser.

## 2026-08-02
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

## 2026-07-29
- Moved the "Setup on Ubuntu" installation guide to the top of the README, right after the intro, instead of after the architecture/algorithms/pricing sections.
- Added `waycontext init-global`: writes (or updates) a `## WayContext Workflow` section into the user's global `~/.claude/CLAUDE.md`, so every project's Claude Code session — not just ones with their own `CLAUDE.md`/`.mcp.json` — prefers `search_code`/`get_graph`/`get_callers`/`get_symbol` over `Grep`/`Glob`/`Explore` when a project is indexed. Unlike project-scoped `init`, it's non-interactive and idempotent (no project name involved), so `install.sh` now runs it automatically (best-effort) right after registering the MCP server.
- Fixed a crash-recovery gap in `indexProject()`'s embedding phase: if the process died (or a Voyage batch failed) after files/symbols were already committed, their content hash matched on the next run, so they were hash-skipped forever and stayed without embeddings. `runIndex()` now re-checks for symbols with `embedding IS NULL` before embedding, so a plain re-run of `index`/`reindex` heals any left over from an earlier crash. Embedding calls are also now chunked (64 symbols) with per-chunk DB writes, so a failing chunk no longer discards vectors already fetched from earlier chunks in the same run.
- Added `hooks/codectx-primary-search.sh` plus `waycontext init-global` support (`src/hookInit.js`): installs a `PreToolUse` hook into `~/.claude/settings.json` that denies `Grep`-tool calls and `grep`/`rg`/`ag` Bash commands whenever the working directory is a project this MCP has indexed, redirecting the caller to `search_code`/`get_symbol`/`get_callers`/`get_graph` instead of a soft reminder — the CLAUDE.md instruction alone wasn't reliably followed. A trailing `# codectx-skip` comment bypasses the check once for legitimate non-code searches (docs, config, logs, test output). Idempotent and self-locating (no hardcoded paths), so `install.sh` sets this up automatically on a fresh clone.
- Added `update.sh` (and `npm run update`): pulls the latest commits (fast-forward only, aborting rather than merging on divergent history or uncommitted local changes) and re-runs `install.sh` so an existing install's npm deps, DB schema, CLI link, MCP registration, global CLAUDE.md section, and PreToolUse hook all get refreshed in one step — additive, never overwrites customized config.
- Added `check-update.sh --install`: a read-only cron check (fetch + compare against origin, no pull, no `install.sh`) that runs every 5 minutes — a fixed daily time isn't reliable on a laptop that isn't always on — but debounces to at most one `notify-send`/log line per calendar day (`~/.cache/waycontext/last-notified-date`), with current status overwritten each run at `~/.cache/waycontext/status` instead of growing unbounded. `--install` upgrades the crontab line in place if the schedule changes instead of leaving a stale duplicate; `--uninstall` removes it; both only touch their own marker-tagged crontab line.

## 2026-07-27
- Fixed a `deadlock detected` (`40P01`) / foreign-key-violation (`23503`) race when two `index_project` runs overlap on the same project (e.g. a commit-hook reindex racing a pull-hook reindex from another session): `indexProject()` now holds a Postgres session-level advisory lock keyed by the project's id for the run's duration, serializing overlapping runs on the same project while leaving other projects free to index in parallel.
- `waycontext index_project` (and its `index`/`reindex` aliases) now runs the CLI spinner for its whole duration instead of skipping it, pausing around its own per-step progress lines so the animation doesn't look stuck during the previously-silent file-by-file processing.

## 2026-07-23
- Added `install.sh`: one-command first-time setup for a fresh clone (PostgreSQL + pgvector, `npm install`, `.env`, `init-db`, `npm link`, and registering the MCP server with Claude Code at user scope via `claude mcp add --scope user waycontext`). Idempotent — safe to re-run.
- Added `waycontext init`: interactively prompts for a project name and writes/updates a `## WayContext` section in `./CLAUDE.md`, asking for y/N confirmation before overwriting an existing section.
- Added `reindex` as another alias for `index_project` (alongside `index`), so the CLI's re-run-after-a-git-diff command reads more naturally.

## 2026-07-22
- Added `projects.last_indexed_sha`, and `indexProject()` now uses it to scope file discovery to `git diff` since the last indexed commit (falling back to a full scan on first index, a non-git root, or when the stored SHA is no longer an ancestor of `HEAD`, e.g. after a rebase) — re-indexing a large repo after a small change no longer requires re-hashing every file.
- Fixed `last_indexed_sha` advancing even when a reindex run had per-file failures; it now only advances after a fully successful run, so failed files stay in the next run's diff instead of silently dropping out of the index.

## 2026-07-21
- Added a reference pricing table (fetched from Voyage's and OpenAI's own docs) to "Tracking token usage & cost", and set `VOYAGE_PRICE_PER_1M_TOKENS`/`OPENAI_PRICE_PER_1M_TOKENS` in `.env` to match.
- Added an "Algorithms & concepts explained" section: plain-language explanations (with Mermaid/ASCII diagrams) of AST parsing, SHA-256 incremental hashing, BFS graph traversal, vector embeddings/cosine distance, HNSW, weighted full-text search, and Reciprocal Rank Fusion — cross-linked from where each term first appears.
- Added `waycontext usage [project]`: every embedding API call now logs its provider/model/input_type and reported token count to a new `embedding_usage` table, viewable as an aggregate report with an estimated cost column when `VOYAGE_PRICE_PER_1M_TOKENS`/`OPENAI_PRICE_PER_1M_TOKENS` is set in `.env`.
- Fixed the CLI spinner showing `✔` (success) even when the wrapped command threw; it now shows `✖` on failure.
- Added a spinner + live elapsed-time indicator to every DB/network-backed `waycontext` subcommand (e.g. `⠹ Searching "..."… 0.8s` → `✔ Searching "..." (1.2s)`), written to stderr so stdout JSON stays pipeable; falls back to a single plain line in non-TTY contexts. `index_project` keeps its own step-by-step log output instead.
- Added a `waycontext` CLI: `src/cli.js` now exposes every MCP tool (`search_code`, `get_symbol`, `get_callers`, `get_callees`, `get_graph`, `get_file_outline`, `find_related`, `project_overview`, `list_projects`) as a subcommand, in addition to the existing `index`/`stats`/`init-db`. Registered as a `bin` entry in `package.json`; run `npm link` to get a global `waycontext` command.
- Added `waycontext db` (interactive `psql` session against `DATABASE_URL`) and `waycontext tables [table] [limit]` (list tables with row counts, or browse a table's rows) for inspecting the Postgres schema directly from the terminal.
- Added a "Database schema" section documenting all 4 tables (`projects`, `files`, `symbols`, `edges`), every column's meaning, and how they relate, so the Postgres structure is understandable without reading `src/db.js`.

## 2026-07-18
- Fixed `Parse failed: ... (Invalid argument)` errors on larger source files: `parseFile` now passes an explicit `bufferSize` to tree-sitter's `parse()`, avoiding a chunked-read bug in the native binding that triggered once file content reached 32768 UTF-16 units.
- Added hybrid search (full-text + pgvector ANN, RRF-fused) to `search_code`.
- Documented why an embedding provider (Voyage/OpenAI) is needed and added a "How `search_code` works" section explaining the full-text/vector/RRF fusion.
