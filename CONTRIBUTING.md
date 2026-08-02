# Contributing to WayContext

Thanks for wanting to help. This document covers the practical bits: how to
get set up, what the code expects, and the one legal formality.

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign the
Contributor License Agreement. A bot comments on the PR with a link; signing
takes about a minute and covers all your future contributions.

Why: the CLA includes a relicensing grant, which keeps the project's licensing
options open. WayContext is Apache-2.0 today and there is no plan to change
that — but without a CLA, changing it later would require tracking down every
past contributor for permission, which in practice means it could never
happen at all. Signing does **not** transfer your copyright; you keep it, and
grant the project a licence to use your work.

## Getting set up

```bash
git clone <your fork>
cd waycontext
./install.sh          # Postgres + pgvector, npm install, schema, CLI link, MCP registration
```

`install.sh` is idempotent. It writes nothing into `~/.claude` beyond
registering the MCP server; the search hook is opt-in
(`codecontext hook install`) and `codecontext uninstall` reverses everything.

Then put an embedding API key in `.env` if you want vector search — everything
degrades to full-text search without one, and the test suite skips the
embedding-dependent cases rather than failing.

## Running the tests

```bash
npm test
```

The suite uses Node's built-in runner (`node:test`) — no Jest, no Vitest.
Several suites need a live Postgres with pgvector; they call `initDb()` in
`before()` and talk to the real database. Tests that need an embedding
provider skip themselves when no key is configured.

Please add tests with your change. The most valuable ones exercise the
incremental paths — reindexing after an edit, a rename, a delete — because
that's where the subtle bugs live.

## Schema changes

The schema is defined by numbered files in `src/migrations/`, applied once
each and recorded in a `schema_migrations` ledger. To change it, add a new
file — never edit an applied one. Migrations are forward-only.

- Name it `NNNN_short_description.sql`, next number in sequence.
- Write it so it's safe to run against a database that already had the change
  applied by hand (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- If it needs `CREATE INDEX CONCURRENTLY`, put `-- codectx:no-transaction` on
  the first line, and keep the file to a single statement.
- `${EMBEDDING_DIM}` is substituted from config before execution.

Check your work with `codecontext migrate --status`.

## Code style

There's no linter yet, so match the surrounding code:

- ESM (`import`/`export`), 2-space indent, double quotes.
- Comments explain *why*, not *what*. The existing comments are a good guide —
  they tend to record the reason a non-obvious choice was made (a git version
  quirk, a node-tree-sitter bug, a lock that prevents a specific race). That
  is the kind of comment worth writing.
- Keep the query layer (`src/graph.js`) free of side effects; indexing writes
  live in `src/indexer.js`.

## Pull requests

- One logical change per PR. A refactor and a behaviour change in the same
  diff is hard to review and harder to revert.
- Say what you verified, and how. "Tests pass" plus the specific manual check
  you ran is ideal.
- If you're planning something large, open an issue first — the roadmap has
  opinions about ordering, and it's a shame to write code that conflicts with
  work already underway.

## Reporting bugs

Include: what you ran, what happened, what you expected, and the output of
`codecontext migrate --status` and `codecontext stats`. If it's an indexing
bug, the smallest source file that reproduces it is worth more than a long
description.

## Security

Please don't open a public issue for a security problem. Email the maintainer
listed in `package.json` instead.
