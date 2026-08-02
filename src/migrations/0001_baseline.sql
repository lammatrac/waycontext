-- Baseline schema: everything initDb() created inline before migrations existed.
--
-- Every statement here is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
-- which is what makes this migration a genuine no-op on databases that predate
-- the migration runner. No baseline-stamping or schema sniffing is needed:
-- the ledger simply records that 0001 ran, and nothing changes.
--
-- ${EMBEDDING_DIM} is substituted by src/migrate.js from config.embeddingDim.

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  root_path   TEXT NOT NULL,
  indexed_at  TIMESTAMPTZ
);

-- Last commit SHA this project was indexed against, so a re-run can ask
-- git for just what changed since then instead of re-hashing every file.
-- NULL means "never git-diff-indexed yet" (first index, or upgraded from
-- a pre-existing project) -- indexer.js falls back to a full scan.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_indexed_sha TEXT;

CREATE TABLE IF NOT EXISTS files (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,            -- relative to project root
  language    TEXT NOT NULL,
  hash        TEXT NOT NULL,            -- sha256 of content, for incremental indexing
  loc         INT DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id     INT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,            -- e.g. "MyClass::render" or "handle_cron"
  kind        TEXT NOT NULL,            -- function | method | class | interface | trait
  signature   TEXT,
  doc         TEXT,                     -- docblock / leading comment
  start_line  INT,
  end_line    INT,
  body        TEXT,                     -- source snippet (truncated)
  embedding   vector(${EMBEDDING_DIM})
);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols (project_id, name);
CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols (file_id);

-- Relationship graph between symbols/files.
-- src/dst reference symbols.id; unresolved targets keep dst NULL + dst_name.
CREATE TABLE IF NOT EXISTS edges (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  src         INT REFERENCES symbols(id) ON DELETE CASCADE,
  dst         INT REFERENCES symbols(id) ON DELETE CASCADE,
  dst_name    TEXT,                     -- raw callee/import name when unresolved
  relation    TEXT NOT NULL,            -- CALLS | IMPORTS | EXTENDS | IMPLEMENTS | INSTANTIATES | FIRES_HOOK | REGISTERS_HOOK
  file_id     INT REFERENCES files(id) ON DELETE CASCADE,
  line        INT
);
CREATE INDEX IF NOT EXISTS edges_src_idx ON edges (src);
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges (dst);
CREATE INDEX IF NOT EXISTS edges_rel_idx ON edges (project_id, relation);

-- One row per embedding API call, for token usage / cost reporting.
-- project_id is SET NULL (not CASCADE) on project deletion so billing
-- history survives a project being dropped/reindexed under a new name.
CREATE TABLE IF NOT EXISTS embedding_usage (
  id          SERIAL PRIMARY KEY,
  project_id  INT REFERENCES projects(id) ON DELETE SET NULL,
  provider    TEXT NOT NULL,           -- voyage | openai
  model       TEXT NOT NULL,
  input_type  TEXT NOT NULL,           -- document | query
  tokens      INT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS embedding_usage_project_idx ON embedding_usage (project_id);
CREATE INDEX IF NOT EXISTS embedding_usage_provider_idx ON embedding_usage (provider, model);

-- HNSW index for fast approximate nearest-neighbour search over symbol embeddings.
CREATE INDEX IF NOT EXISTS symbols_embedding_idx
  ON symbols USING hnsw (embedding vector_cosine_ops);

-- Full-text search column for hybrid search. A STORED generated column
-- backfills automatically for existing rows.
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS fts_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(doc,  '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS symbols_fts_idx ON symbols USING gin (fts_vector);
