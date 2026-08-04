# Installation & configuration

Full setup: database, embedding providers, the CLI, MCP registration, and cost tracking.
For the 60-second version see the [README](../README.md); if something goes wrong see
[Troubleshooting](troubleshooting.md).


## From npm

The database comes first: everything after step 1 needs it, and `migrate` is the point where
its absence would otherwise surface as a connection error.

**1. A PostgreSQL with pgvector** — see [1. PostgreSQL + pgvector](#1-postgresql--pgvector)
for the one-line Docker option and the apt alternative.

**2. Install, and point WayContext at that database.**

```bash
npm install -g waycontext            # or run one-off with: npx waycontext <command>
export DATABASE_URL=postgres://codectx:your-password@localhost:5432/codectx
```

Rather than exporting it each time, put it in `~/.config/waycontext/config.json` (override the
path with `$WAYCONTEXT_CONFIG`). Add the embedding keys here too, if you want semantic search:

```json
{
  "DATABASE_URL": "postgres://codectx:your-password@localhost:5432/codectx",
  "EMBEDDING_PROVIDER": "voyage",
  "VOYAGE_API_KEY": "..."
}
```

**3. Create the schema and index a project.**

```bash
waycontext migrate
waycontext index_project myapp /path/to/myapp
```

**4. Register the MCP server with your client.**

```bash
claude mcp add --scope user waycontext -- waycontext-mcp
```

If any of this fails, [Troubleshooting](troubleshooting.md) is organised by symptom — and every
CLI command takes `--debug` to show the underlying stack trace.

## From a clone

For a fresh clone, `install.sh` automates everything below: installs PostgreSQL + pgvector if not already present, runs `npm install`, copies `.env.example` to `.env` (if missing), initializes the database schema, links the `waycontext` CLI, and registers the MCP server with Claude Code at **user scope** (`claude mcp add --scope user waycontext`, available in every project, not just this one). It writes nothing else into `~/.claude` — the search hook and the per-project `CLAUDE.md` section are opt-in (`waycontext hook install`, `waycontext init`).

```bash
./install.sh
```

It's idempotent — safe to re-run after a `git pull`. Afterwards, edit `.env` to add your `VOYAGE_API_KEY`/`OPENAI_API_KEY`, then restart Claude Code. The steps below explain what it automates, for manual setup, non-Ubuntu systems, or troubleshooting.

## Updating an existing install

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

## 1. PostgreSQL + pgvector

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

## 2. Install & init

```bash
cd waycontext
npm install
cp .env.example .env    # fill in DATABASE_URL, and an embedding API key if you want one
waycontext migrate      # equivalently: npm run init-db
```

## 3. CLI

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

# project + search
waycontext index_project <project-name> /path/to/project/    # aliases: index, reindex
waycontext list_projects
waycontext project_overview <project-name>
waycontext search_code <project-name> "purge cache after match update"    # alias: search
waycontext search_knowledge <project-name> "why is X this way" [limit]    # alias: knowledge

# symbol navigation
waycontext get_symbol <project-name> <name>
waycontext get_callers <project-name> <name>
waycontext get_callees <project-name> <name>
waycontext get_graph <project-name> <name> [depth]
waycontext get_file_outline <project-name> <path>
waycontext find_related <project-name> <name> [limit]

# history, ownership, rules, memory
waycontext get_history <project-name> [target] [limit]     # alias: history
waycontext who_owns <project-name> [target] [limit]        # alias: owners
waycontext get_rules <project-name> [target]                # alias: rules
waycontext remember <project-name> "<content>" [kind] [scope] [supersedes] [pinned]
waycontext recall <project-name> "<query>" [limit]
waycontext review_context <project-name> [paths]             # alias: review

# architecture intelligence
waycontext get_modules <project-name> [sort] [limit]        # alias: modules
waycontext get_module <project-name> <module>                # alias: module
waycontext get_cochange <project-name> <target> [limit]      # alias: cochange
waycontext get_bug_clusters <project-name> [limit]           # alias: bugs
waycontext compose_context <project-name> "<task>" [budget] [format]    # alias: context

# admin
waycontext tables                        # list tables + approx row counts
waycontext tables symbols 50             # browse rows of one table (default limit 20)
waycontext db                             # interactive psql session against DATABASE_URL
waycontext usage                          # embedding token usage, all projects
waycontext usage <project-name>           # embedding token usage, one project
```

`index`/`reindex` are kept as aliases for `index_project` (and the other aliases noted inline above), and `stats` prints `list_projects` as a table instead of JSON. `db` requires the `psql` client (`sudo apt install -y postgresql-client` if missing). `init` prompts for a project name and writes (or updates) a `## WayContext` section in `./CLAUDE.md`, so an agent reading that file knows which project name to pass to the tools above — it asks for y/N confirmation before overwriting an existing section. `hook install` is the optional, stronger nudge — see [5. Optional: nudge agents toward the MCP](#5-optional-nudge-agents-toward-the-mcp) below. See [docs/api.md](api.md) for the full argument/description reference for every operation above, and [docs/knowledge.md](knowledge.md) for `rule candidates|confirm|reject` and `knowledge-export`/`knowledge-import`, which are CLI-only and intentionally not exposed as MCP tools.

Every DB/network-backed subcommand shows a spinner with a live elapsed-time counter (e.g. `⠹ Searching "purge cache"… 0.8s`) while it runs, then a final `✔ label (Xs)` line — so a slow embedding-API call or a big-table scan doesn't look hung. It only starts animating after ~150ms (fast queries just print the final line, no flicker), and it's written to **stderr**, so stdout stays clean JSON for piping (`waycontext search_code proj query 2>/dev/null | jq`). In a non-TTY context (CI, redirected output) it skips the animation and prints just the final line. `index_project` runs the same spinner for its whole duration, pausing it around its own per-step `console.log` progress lines (`Found N source files`, `Resolving graph edges…`, …) so the two don't collide — this keeps the animation visible during the otherwise-silent file-by-file processing in between.

## Tab completion (bash)

```bash
waycontext completion install     # write the script
waycontext completion uninstall   # remove it
waycontext completion bash        # or print it and place it yourself
```

Completes subcommands and their aliases, sub-verbs (`hook install|uninstall|refresh`),
flags, and — for any argument that takes one — indexed project names:

```
$ waycontext search_code <TAB>
waycontext  dating-local  sports-wc-2026
```

The file lands in `${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/`,
which bash-completion loads on demand by command name, so **no `.bashrc` change is
needed** — just open a new shell. `install.sh` regenerates it on upgrade if you have
it installed, and leaves you alone if you don't.

Project names come from the same `~/.cache/waycontext/projects.json` the search hook
uses, so completion never touches the database. It inherits that cache's one caveat:
if the cache was written against a different `DATABASE_URL`, run
`waycontext hook refresh`. Without `jq` a slower fallback is used; without the cache
you still get every subcommand.

zsh is not supported yet.

## 4. Register with Claude Code

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

## 5. Optional: nudge agents toward the MCP

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

## Why an embedding provider?

Semantic search — the vector-ANN half of `search_code` and all of `find_related` — needs a numeric embedding for every indexed symbol. This server doesn't run a local embedding model, so it calls an external API to generate those vectors at index time (and for each query). `VOYAGE_API_KEY` / `OPENAI_API_KEY` in `.env` are what that call authenticates with:

- **Voyage AI** (`voyage-code-3`) — the recommended default. It's trained specifically on code, so it tends to place semantically similar functions closer together than a general-purpose text embedding model would.
- **OpenAI** (`text-embedding-3-small`) — a general-purpose alternative, useful if you already have OpenAI API access and would rather not manage a second provider's key.
- **`EMBEDDING_PROVIDER=none`** — skip embeddings entirely, and **the shipped default** in `.env.example`. `index_project`, the graph tools (`get_graph`, `get_callers`, `get_callees`, `get_file_outline`, `project_overview`), and the full-text half of `search_code` all work with no API key. You only lose the semantic/ANN component of `search_code` (matches found by meaning, not just shared words) and `find_related` returns nothing. Measured cost of that trade-off: recall@10 drops to 0.00 from 0.66 — see [Retrieval quality](evaluation.md).

Setting a provider **without** its key fails fast, before any indexing work happens, rather than part-way through a run with an API `401`.

Either provider is a fine choice — pick whichever fits your budget or existing infra. Just make sure `EMBEDDING_DIM` matches the model you pick (see comments in `.env.example`); changing it later requires re-running `init-db` and reindexing.

### Tracking token usage & cost

Every embedding API call (indexing documents, or embedding a `search_code` query) logs its `provider`, `model`, `input_type`, and the token count the API reported into the `embedding_usage` table — see [Database schema](architecture.md#database-schema). View it with:

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

`VOYAGE_PRICE_PER_1M_TOKENS=0.18` and `OPENAI_PRICE_PER_1M_TOKENS=0.02` (the standard, non-batch rate) ship in `.env.example`, matching the default models (`VOYAGE_MODEL`/`OPENAI_EMBEDDING_MODEL`) — update them if you switch models or a provider changes pricing. Configuring by hand instead of via `.env`? Set them yourself, or `usage` shows token counts with no `est_cost_usd`.

Usage tracking only covers calls made after upgrading to this version — run `waycontext init-db` once to create the `embedding_usage` table if it doesn't exist yet.

