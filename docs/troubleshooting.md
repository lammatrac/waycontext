# Troubleshooting

Problems people actually hit, grouped by where they show up. Full setup steps live in
[Installation & configuration](installation.md).

## Where settings come from

Most "it ignored my config" reports are a precedence surprise. Settings are read, **highest
precedence first**, from:

1. the environment
2. `./.env` in the directory you run from
3. `.env` next to the install
4. `~/.config/waycontext/config.json` (override the path with `$WAYCONTEXT_CONFIG`)
5. built-in defaults

Set `WAYCONTEXT_IGNORE_DOTENV=1` to skip the `.env` files entirely and configure purely from
the environment. If a value isn't taking effect, check for a `.env` in your current working
directory shadowing the one you edited.

> **Every command takes `--debug`** (or `WAYCONTEXT_DEBUG=1`), which prints the underlying
> stack trace instead of the one-line explanation. Worth reaching for when a message here
> doesn't match what you're seeing.

## Database connection

### `Can't reach the PostgreSQL database`

Nothing is listening on the host and port WayContext tried. The message names both the URL it
used and where that URL came from — check that first, because the most common cause is a
`DATABASE_URL` you didn't realise was set (see [Where settings come from](#where-settings-come-from)),
or the built-in default being used because nothing set it at all.

If the URL is right, the database isn't running. Start one:

```bash
DB_PASS=your-password docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml ps      # confirm it's up
```

Note that `install.sh` picks the next free port (5433, 5434…) when 5432 is already taken, and
writes that port into `.env` — so the URL may legitimately not be 5432.

### `The database rejected these credentials`

The host is reachable but the username/password pair isn't accepted. The subtlety worth
knowing: **PostgreSQL only applies `POSTGRES_PASSWORD` when it first initialises its data
directory.** If a `waycontext-pgdata` volume already exists from an earlier run, it keeps the
password it was created with, and passing a new `DB_PASS` to `docker compose up` changes
nothing. Either use the original password, or discard the volume and start fresh:

```bash
docker compose -f docker/docker-compose.yml down -v    # -v discards the indexed data
```

This is also what happens if you delete `.env` and re-run `install.sh`: the script generates a
new random password, but the existing volume still wants the old one.

### `The database is reachable but has no WayContext schema`

Run `waycontext migrate`. This is expected on a database you provisioned by hand, or after
pointing `DATABASE_URL` at a different server.

### `This PostgreSQL doesn't have the pgvector extension available`

`CREATE EXTENSION vector` failed because the server has no pgvector to install. Use the
`pgvector/pgvector:pg16` image (which `docker/docker-compose.yml` does), or install the
extension for your existing server — see
[1. PostgreSQL + pgvector](installation.md#1-postgresql--pgvector).

## Install & build

### `build-essential` / `python3` errors while installing

The tree-sitter packages ship prebuilt binaries: every grammar covers linux-x64, darwin-x64,
darwin-arm64 and win32-x64, and the Python/Go grammars add linux-arm64 and win32-arm64. Only
platforms with no prebuild compile from source — **musl/Alpine, the BSDs, and linux-arm64 for
the older grammars**. On those, install a toolchain first:

```bash
sudo apt install -y build-essential python3     # Debian/Ubuntu
apk add build-base python3                      # Alpine
```

`install.sh` offers this on those platforms and nowhere else.

### `postgresql-16-pgvector` has no installation candidate (older Ubuntu/Debian)

The packaged extension only exists on recent releases. Build it from source:

```bash
sudo apt install -y postgresql-server-dev-16 build-essential git
git clone https://github.com/pgvector/pgvector && cd pgvector && make && sudo make install
```

Then `CREATE EXTENSION vector;` in your database. Or skip the whole problem with the Docker
path — the `pgvector/pgvector:pg16` image already contains the extension:

```bash
DB_PASS=your-password docker compose -f docker/docker-compose.yml up -d
```

### Port 5432 is already in use

Override `DB_PORT` before starting the compose file. `install.sh` detects this case on its
own, picks the next free port, and writes the right port into `.env`.

### `waycontext db` says `psql: command not found`

The interactive `db` subcommand shells out to the PostgreSQL client, which isn't bundled:

```bash
sudo apt install -y postgresql-client     # Debian/Ubuntu
brew install libpq                        # macOS
```

Every other subcommand talks to the database directly and needs nothing extra.

## After an update

### `there is no unique or exclusion constraint matching the ON CONFLICT specification`

**Restart your MCP client.** `update.sh` applies pending migrations to the database, but an
MCP server process that was already running keeps the old code loaded. Most migrations are
additive and a stale process is harmless — this one isn't: `0002_orgs` replaces the global
unique constraint on `projects.name` with a per-org one, so a server started before it fails
`index_project` with this error until restarted. The CLI is unaffected; it's a fresh process
each time.

### `update.sh` aborted instead of pulling

It is fast-forward only by design. It aborts rather than merging or rebasing if your local
history has diverged, and aborts rather than stashing or discarding if you have uncommitted
changes. Commit or stash your work, or reconcile the branch by hand, then re-run it.

### Every project on this machine started refusing `grep`

An older version installed the `PreToolUse` hook **globally and unattended, in `deny` mode**,
alongside a `## WayContext Workflow` section in `~/.claude/CLAUDE.md`. Both are opt-in now.
To clean up a machine set up the old way:

```bash
waycontext uninstall
```

It removes the hook (project and global), the global CLAUDE.md section, and the cache,
leaving your own content and any unrelated hooks intact. It prints — but does not run — the
commands to unregister the MCP server, unlink the CLI, and drop the database.

## Indexing

### Changing `EMBEDDING_DIM` broke everything

`EMBEDDING_DIM` must match the model you picked (see the comments in `.env.example`).
Changing it after the fact requires re-running `init-db` and reindexing — the stored vectors
have the old width and the HNSW index is built for it.

### Markdown docs aren't showing up in `search_knowledge`

Re-indexing is scoped to `git diff` since `projects.last_indexed_sha`, so docs that haven't
been edited since your last index are in no diff and will never be picked up by an
incremental run. One full scan fixes it permanently:

```sql
UPDATE projects SET last_indexed_sha = NULL WHERE name = 'myproject';
```

then `waycontext index myproject <path>` once. New projects need nothing — their first index
is a full scan anyway.

### Symbols indexed by an older version have no entity id

They pick one up for free the next time their file changes, so nothing is required of you.
To do it now, without reparsing anything:

```bash
waycontext backfill-identity                 # all projects
waycontext backfill-identity myproject       # one project
waycontext backfill-identity --status --json # what's left to do
```

Batched by file, resumable, and safe to interrupt. It's a separate command rather than part
of a migration on purpose — on a 326k-symbol database it measured **over 12 minutes**, and
migrations run at MCP server startup.

### A module depends on something it obviously doesn't

Call resolution is name-based, with no scope analysis, so a call to a *parameter* resolves to
whatever project function shares its name. Harmless for `search_code`, misleading in the
architecture graph. See [Notes & limits](../README.md#notes--limits).

## Search

### `search_code` returns nothing for natural-language queries

Check whether `EMBEDDING_PROVIDER=none`. Without embeddings, only the full-text half runs,
and `plainto_tsquery` **ANDs every term** — so a sentence-shaped query returns nothing at all
unless one symbol happens to contain all of its words. Measured on this repository's own
history: recall@10 is **0.00** with embeddings off versus **0.66** with them on. See
[Retrieval quality](evaluation.md).

Workarounds without a provider: query with one or two distinctive identifiers rather than a
sentence, or use the graph tools (`get_graph`, `get_callers`, `get_file_outline`), which
don't depend on embeddings at all.

### Multi-word queries miss a camelCase symbol

Postgres's full-text tokenizer splits on punctuation and whitespace, not on camelCase or
snake_case boundaries, so `purgeCacheAfterMatchUpdate` is one token, not four words. The
vector half finds these when embeddings are on.

## MCP & agents

### The tools don't appear in Claude Code

Check the registration scope — `install.sh` registers at **user scope**, available in every
project:

```bash
claude mcp add --scope user waycontext -- waycontext-mcp
```

Restart the client after registering or updating. If the agent has the tools but keeps
reaching for `grep` instead, see the opt-in nudge hook under
[Installation](installation.md#5-optional-nudge-agents-toward-the-mcp), and `waycontext init`
to write the project name into `./CLAUDE.md`.

### The hook fires in the wrong project, or not at all

Project roots come from `~/.cache/waycontext/projects.json`, rewritten by `hook install` and
after every `index_project` — from whichever database that run used. Pointing the CLI at a
different `DATABASE_URL` leaves the cache describing that one. Rebuild it without reindexing:

```bash
waycontext hook refresh
```

Anything unexpected (no cache, cwd not indexed, `jq` missing) exits silently and leaves the
tool call alone. When roots are nested, the deepest match wins. A trailing `# codectx-skip`
comment bypasses any mode once.

### `waycontext serve` refuses to start on a non-local address

Deliberate. It binds to `127.0.0.1` and refuses to bind anywhere else unless
`WAYCONTEXT_ALLOW_PUBLIC_BIND=1` is set, because there is **no authentication** — an
unauthenticated endpoint that reads your source code must not be one config typo away from
the network.

### A `compose_context` response is missing a channel

That's reported, not hidden: every channel that misses its deadline or errors is named in
`meta.degraded_channels`. Cold requests cost one embedding-provider round trip more than warm
ones (~450 ms). See [The context API](api.md#the-context-api).
