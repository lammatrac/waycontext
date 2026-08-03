-- Phase 1: the identity plane and the first slice of the knowledge plane.
--
-- Until now there was exactly one plane -- files -> symbols -> edges -- and it
-- is deliberately disposable: indexer.js deletes and reinserts every symbol of
-- a changed file on each run, so symbol ids churn constantly. Nothing durable
-- can be attached to an id that is reassigned whenever someone saves a file.
--
-- This migration adds the two planes above it:
--
--   identity   entities, symbol_aliases        append + tombstone, ids never reused
--   knowledge  commits, commit_files, people,  durable, survives reindexing
--              issues, entity_links, chunks
--
-- `edges` is untouched on purpose. Code->code relations are parsed output and
-- belong on the disposable plane; routing them through entity_links would
-- thrash a durable table millions of rows at a time.
--
-- This migration is schema-only and runs in milliseconds. Giving PRE-EXISTING
-- symbols their keys and entities is deliberately NOT done here -- see
-- src/backfillIdentity.js and `waycontext backfill-identity`.
--
-- The reason is measured, not theoretical. `symbols` carries a vector(1024)
-- column, a 1.6 GB HNSW index and a STORED generated tsvector; on a 326k-symbol
-- database the table is 5.1 GB. Any UPDATE touching every row rewrites the
-- whole heap, recomputes every tsvector and re-inserts every vector into the
-- HNSW graph. Doing that three times inside a migration took over 12 minutes
-- -- and applyMigrations() runs on MCP server startup, so that is 12 minutes
-- of a client that looks hung. A separate, batched, resumable command is the
-- right shape for a job with that cost profile.
--
-- Nothing depends on the backfill having run: symbols indexed from here on get
-- their key and entity at INSERT time for free, an un-backfilled symbol simply
-- has entity_id NULL, and every query degrades to the file path.

-- ---------------------------------------------------------------------------
-- Identity plane
-- ---------------------------------------------------------------------------

-- Thin registry + typed satellites, rather than pure-polymorphic JSONB or nine
-- typed tables with pairwise link tables. `entities` owns identity, linkage and
-- searchability for every kind of thing WayContext knows about; the satellite
-- tables below own the columns you actually filter and aggregate on. Retrieval
-- never pays for the join, aggregation does.
--
-- project_id is NOT NULL even for kinds that are conceptually org-wide (people
-- most obviously). Cross-project identity resolution is a later, harder problem
-- -- "is trac@work.com the same human as trac@personal.com" -- and a nullable
-- project_id would silently disable the uniqueness constraint below, since
-- Postgres treats NULLs as distinct in unique indexes before 15.
CREATE TABLE IF NOT EXISTS entities (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,            -- symbol | commit | issue | person | document | decision | rule | memory
  natural_key  TEXT NOT NULL,            -- stable within (project_id, kind); see src/identity.js
  title        TEXT,
  summary      TEXT,
  occurred_at  TIMESTAMPTZ,              -- when the thing happened (commit date, issue open date)
  source       TEXT NOT NULL DEFAULT 'parsed',  -- parsed | git | inferred | manual | <connector name>
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Tombstone rather than delete: a knowledge row may still point here, and a
  -- deleted symbol that comes back (revert, branch switch) must get its id back,
  -- not a new one.
  deleted_at   TIMESTAMPTZ,
  UNIQUE (project_id, kind, natural_key)
);
CREATE INDEX IF NOT EXISTS entities_kind_idx     ON entities (project_id, kind);
CREATE INDEX IF NOT EXISTS entities_occurred_idx ON entities (project_id, kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS entities_live_idx     ON entities (project_id, kind) WHERE deleted_at IS NULL;

-- Durable relations between entities. Split from `edges` by lifecycle, not by
-- subject matter: everything in here is written once and expected to survive.
CREATE TABLE IF NOT EXISTS entity_links (
  id         BIGSERIAL PRIMARY KEY,
  org_id     INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  src_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,   -- AUTHORED_BY | CO_AUTHORED_BY | REFERENCES | FIXES | TOUCHES | MENTIONS
  weight     REAL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (src_id, relation, dst_id)
);
CREATE INDEX IF NOT EXISTS entity_links_dst_idx ON entity_links (dst_id, relation);

-- Stable identity for parsed symbols.
--
--   symbol_key       "src/graph.js#function:searchCode" (see src/identity.js)
--   body_fingerprint sha256 of the whitespace-normalised body, used ONLY to
--                    detect renames/moves within one index run
--   entity_id        the durable id knowledge attaches to
--
-- symbol_key is deliberately not a content hash: a content hash changes on
-- every edit, which is exactly the moment the link has to survive.
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS symbol_key       TEXT;
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS body_fingerprint TEXT;
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS entity_id        BIGINT REFERENCES entities(id) ON DELETE SET NULL;

-- Non-unique on purpose. Keys are unique by construction (the path is in the
-- key and duplicates within a file get a ~n suffix), and `entities` already
-- enforces uniqueness where it is load-bearing. A unique index here would turn
-- a key-generation bug into "indexing is broken" instead of "two symbols share
-- an entity"; a test asserts per-file uniqueness instead.
CREATE INDEX IF NOT EXISTS symbols_key_idx    ON symbols (project_id, symbol_key);
CREATE INDEX IF NOT EXISTS symbols_entity_idx ON symbols (entity_id);

-- Former keys of a symbol that was renamed or moved. Lets a link recorded
-- against yesterday's path still resolve after the file is moved.
CREATE TABLE IF NOT EXISTS symbol_aliases (
  id         BIGSERIAL PRIMARY KEY,
  org_id     INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  symbol_key TEXT NOT NULL,       -- the OLD key, which now resolves to entity_id
  path       TEXT NOT NULL,       -- the OLD file path, so history survives a move
  reason     TEXT NOT NULL,       -- rename | move
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, symbol_key)
);
CREATE INDEX IF NOT EXISTS symbol_aliases_entity_idx ON symbol_aliases (entity_id);

-- ---------------------------------------------------------------------------
-- Knowledge plane: chunks
-- ---------------------------------------------------------------------------

-- Embeddable text belonging to a non-code entity (docs, ADRs, issue threads).
-- Created here rather than in Phase 2 so the HNSW index exists before there is
-- any data to rebuild it over, and so retrieval can start fusing chunk ids the
-- day the first document is ingested.
CREATE TABLE IF NOT EXISTS chunks (
  id             BIGSERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id      BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  ord            INT NOT NULL,            -- position within the parent entity
  heading_path   TEXT,                    -- "Architecture > Storage > Chunking"
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,           -- re-embed only when this changes
  token_estimate INT,
  embedding      vector(${EMBEDDING_DIM}),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_id, ord)
);

-- Generated, so chunk search degrades to full-text-only exactly the way symbol
-- search already does when embeddings are switched off.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(heading_path, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS chunks_fts_idx       ON chunks USING gin (fts_vector);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_entity_idx    ON chunks (entity_id, ord);

-- ---------------------------------------------------------------------------
-- Knowledge plane: git history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people (
  entity_id       BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_name    TEXT,
  canonical_email TEXT,
  emails          TEXT[] NOT NULL DEFAULT '{}',   -- every address seen for this identity
  commit_count    INT NOT NULL DEFAULT 0,
  first_seen_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS people_project_idx ON people (project_id);

CREATE TABLE IF NOT EXISTS commits (
  entity_id        BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha              TEXT NOT NULL,
  short_sha        TEXT NOT NULL,
  author_name      TEXT,
  author_email     TEXT,
  author_person_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  authored_at      TIMESTAMPTZ,
  committed_at     TIMESTAMPTZ,
  subject          TEXT,
  body             TEXT,
  parent_count     INT NOT NULL DEFAULT 0,
  is_merge         BOOLEAN NOT NULL DEFAULT false,
  is_fix           BOOLEAN NOT NULL DEFAULT false,
  is_revert        BOOLEAN NOT NULL DEFAULT false,
  files_changed    INT NOT NULL DEFAULT 0,
  insertions       INT NOT NULL DEFAULT 0,
  deletions        INT NOT NULL DEFAULT 0,
  UNIQUE (project_id, sha)
);
CREATE INDEX IF NOT EXISTS commits_authored_idx ON commits (project_id, authored_at DESC);
CREATE INDEX IF NOT EXISTS commits_fix_idx      ON commits (project_id, authored_at DESC) WHERE is_fix;

-- Per-file churn. `path` is text rather than a files(id) FK on purpose: a
-- commit routinely touches files that have since been deleted, were never
-- indexed (a .md, a lockfile), or predate this project's first index. Losing
-- those rows would make churn and ownership silently wrong.
CREATE TABLE IF NOT EXISTS commit_files (
  id               BIGSERIAL PRIMARY KEY,
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,        -- relative to the project root, like files.path
  additions        INT NOT NULL DEFAULT 0,
  deletions        INT NOT NULL DEFAULT 0,
  is_binary        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (commit_entity_id, path)
);
CREATE INDEX IF NOT EXISTS commit_files_path_idx ON commit_files (project_id, path);

CREATE TABLE IF NOT EXISTS issues (
  entity_id    BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tracker      TEXT NOT NULL,        -- github | jira | inferred
  external_key TEXT NOT NULL,        -- "1532", "PROJ-1532"
  url          TEXT,
  state        TEXT,
  title        TEXT,
  labels       TEXT[] NOT NULL DEFAULT '{}',
  opened_at    TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  UNIQUE (project_id, tracker, external_key)
);

-- Where git-history ingestion got to, so the next run reads only new commits.
-- Mirrors projects.last_indexed_sha and advances under the same rule: only
-- when the run had no failures.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_history_sha  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS history_indexed_at TIMESTAMPTZ;

-- No backfill here, on purpose. See the header: `waycontext backfill-identity`
-- does it in resumable batches, and src/backfillIdentity.js carries the SQL
-- (whose key-numbering rule is asserted against assignSymbolKeys() by a test).
