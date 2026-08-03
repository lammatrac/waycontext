-- Phase 4: derived intelligence.
--
-- Everything here is a FOURTH layer, and the important thing about it is that it
-- is disposable like the parse plane, not durable like the knowledge plane:
--
--   parse      files, symbols, edges              rebuilt from source
--   identity   entities, symbol_aliases           append + tombstone
--   knowledge  commits, documents, rules, ...     durable
--   derived    modules, cochange, ownership, ...   recomputed from the three above
--
-- So modules are deliberately NOT entities. An entity id is a promise that
-- durable knowledge can be attached to it forever; a module is a summary of
-- whatever the tree looks like today, and if the module model changes (a
-- different depth, a different clustering rule) every row here is thrown away
-- and rebuilt. Making modules entities would put a rebuildable id under a
-- rule someone confirmed, which is the exact mistake the three-plane split
-- exists to prevent. `derived_state` below is what makes throwing them away
-- cheap and safe.
--
-- Nothing in here is on a retrieval hot path, so nothing in here gets an HNSW
-- index or a tsvector. These tables are read by aggregate queries a handful of
-- rows at a time.

-- ---------------------------------------------------------------------------
-- Watermarks
-- ---------------------------------------------------------------------------

-- One row per (project, derivation). `input_watermark` is an opaque string
-- describing the inputs a derivation consumed -- today
-- "sha:<last_indexed_sha>|hist:<last_history_sha>" -- and derive.js skips any
-- kind whose watermark is unchanged. Opaque on purpose: whether a derivation
-- depends on the parse plane, on history, or on both is derive.js's business,
-- and encoding that here as columns would mean a migration every time a new
-- derivation has a different input set.
CREATE TABLE IF NOT EXISTS derived_state (
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,     -- modules | metrics | cochange | ownership | clusters
  input_watermark TEXT NOT NULL,
  row_count       INT NOT NULL DEFAULT 0,
  duration_ms     INT,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind)
);

-- ---------------------------------------------------------------------------
-- Modules
-- ---------------------------------------------------------------------------

-- A module is a directory, at a configurable depth (MODULE_DEPTH, default 2).
--
-- Not graph community detection. Louvain over `edges` finds tighter clusters,
-- but a community id is not stable between runs -- add one file and the
-- partition can shift -- and every metric below is only meaningful when
-- compared against the same module last week. "src/knowledge" is stable, and it
-- is also what people say out loud when they talk about the code.
CREATE TABLE IF NOT EXISTS modules (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,   -- "src/knowledge"; "." for files at the root
  name         TEXT NOT NULL,   -- "knowledge"
  depth        INT NOT NULL,
  file_count   INT NOT NULL DEFAULT 0,
  loc          INT NOT NULL DEFAULT 0,
  symbol_count INT NOT NULL DEFAULT 0,
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS modules_project_idx ON modules (project_id);

CREATE TABLE IF NOT EXISTS module_members (
  module_id BIGINT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  file_id   BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (module_id, file_id)
);
CREATE INDEX IF NOT EXISTS module_members_file_idx ON module_members (file_id);

-- `edges` lifted from file->file to module->module. Self-edges are dropped by
-- the writer: every module depends on itself and saying so buries the signal.
CREATE TABLE IF NOT EXISTS module_deps (
  project_id    INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  src_module_id BIGINT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  dst_module_id BIGINT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  edge_count    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (src_module_id, dst_module_id)
);
CREATE INDEX IF NOT EXISTS module_deps_dst_idx ON module_deps (dst_module_id);

-- ---------------------------------------------------------------------------
-- Metrics
-- ---------------------------------------------------------------------------

-- `window_days` is stored rather than assumed: a row computed under a 90-day
-- window and one computed under a 365-day window are not comparable, and
-- without the column a changed setting silently reinterprets old numbers.
CREATE TABLE IF NOT EXISTS module_metrics (
  module_id      BIGINT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE,
  project_id     INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  window_days    INT NOT NULL,
  commits        INT NOT NULL DEFAULT 0,
  fix_commits    INT NOT NULL DEFAULT 0,
  authors        INT NOT NULL DEFAULT 0,
  additions      INT NOT NULL DEFAULT 0,
  deletions      INT NOT NULL DEFAULT 0,
  churn          INT NOT NULL DEFAULT 0,   -- additions + deletions in the window
  defect_density REAL NOT NULL DEFAULT 0,  -- fix_commits / commits
  risk           REAL NOT NULL DEFAULT 0,  -- 0..100, see src/knowledge/metrics.js
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS module_metrics_risk_idx ON module_metrics (project_id, risk DESC);

-- Pairwise co-change. Genuinely O(commits x files^2) to compute and a join away
-- from useless to compute on demand, which is why it is materialised.
--
-- Paths, not file ids: a pair is interesting precisely when one side has since
-- been deleted or renamed, and commit_files stores paths for the same reason.
-- The writer enforces path_a < path_b so a pair has exactly one row.
CREATE TABLE IF NOT EXISTS cochange (
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path_a       TEXT NOT NULL,
  path_b       TEXT NOT NULL,
  pair_commits INT NOT NULL,
  a_commits    INT NOT NULL,
  b_commits    INT NOT NULL,
  confidence   REAL NOT NULL,   -- pair_commits / least(a_commits, b_commits)
  lift         REAL,            -- confidence over the base rate of the rarer file
  PRIMARY KEY (project_id, path_a, path_b)
);
CREATE INDEX IF NOT EXISTS cochange_a_idx ON cochange (project_id, path_a, confidence DESC);
CREATE INDEX IF NOT EXISTS cochange_b_idx ON cochange (project_id, path_b, confidence DESC);

-- Module-level ownership, recency-weighted (OWNERSHIP_HALF_LIFE_DAYS).
-- who_owns() already answers this per file straight from commit_files and is
-- left alone; this is the aggregate that would be too slow to compute per call.
CREATE TABLE IF NOT EXISTS ownership (
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id        BIGINT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  person_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight           REAL NOT NULL,   -- decayed churn
  share            REAL NOT NULL,   -- weight / module total, 0..1
  commits          INT NOT NULL,
  last_touched_at  TIMESTAMPTZ,
  PRIMARY KEY (module_id, person_entity_id)
);
CREATE INDEX IF NOT EXISTS ownership_person_idx ON ownership (person_entity_id);

-- ---------------------------------------------------------------------------
-- Bug clusters
-- ---------------------------------------------------------------------------

-- Clustered over FIX COMMITS, not issues, which is a deliberate deviation from
-- the roadmap. `issues` rows exist, but they are extracted from commit-message
-- references (#123, PROJ-45) and carry only tracker, key and URL -- no title,
-- no body, no labels -- because nothing here talks to a tracker yet. There is
-- literally no text on an issue to embed until a connector exists. Fix commit
-- messages are the text this project actually has, and they are what someone
-- means when they ask "what keeps breaking here?".
--
-- `method` records how a cluster was built so a terms-only cluster (embeddings
-- off) is never mistaken for a semantic one.
CREATE TABLE IF NOT EXISTS bug_clusters (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  terms         TEXT[] NOT NULL DEFAULT '{}',
  size          INT NOT NULL DEFAULT 0,
  module_id     BIGINT REFERENCES modules(id) ON DELETE SET NULL,  -- dominant module
  method        TEXT NOT NULL,   -- embedding | terms
  first_seen_at TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bug_clusters_project_idx ON bug_clusters (project_id, size DESC);

CREATE TABLE IF NOT EXISTS bug_cluster_members (
  cluster_id       BIGINT NOT NULL REFERENCES bug_clusters(id) ON DELETE CASCADE,
  commit_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  similarity       REAL,
  PRIMARY KEY (cluster_id, commit_entity_id)
);

-- Fix-commit message embeddings, filled on the same embed-on-NULL principle as
-- chunks: only where is_fix, only where NULL, so a re-derive costs nothing and
-- a crashed run heals on the next one.
--
-- No HNSW index, on purpose. Clustering reads every fix-commit vector into
-- memory in one pass (thousands of rows, not the 326k of `symbols`); an ANN
-- index would be maintained for a query nobody makes.
ALTER TABLE commits ADD COLUMN IF NOT EXISTS message_embedding vector(${EMBEDDING_DIM});
