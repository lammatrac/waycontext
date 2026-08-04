# Knowledge: rules, memory, docs & history

The durable layer — what the project has decided, what it has learned, and what its history
says — as opposed to the parse plane, which is rebuilt from source on every index.

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
its quality is measured by [`eval/`](evaluation.md) against real commits, so
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
location — see [Stable identity](architecture.md#stable-identity-symbol-keys-and-entities).

Incremental on re-index via `projects.last_history_sha`, with the same
`merge-base --is-ancestor` guard as the code index: if history was rewritten, it falls
back to a full pass instead of silently skipping commits. The first pass over a
repository is bounded by `HISTORY_WINDOW_MONTHS` (24) and `HISTORY_MAX_COMMITS` (20000);
set either to `0` to remove the bound, or `HISTORY_ENABLED=0` to skip history entirely.

