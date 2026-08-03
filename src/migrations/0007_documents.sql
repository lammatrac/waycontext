-- ---------------------------------------------------------------------------
-- Knowledge plane: documents (Phase 2)
-- ---------------------------------------------------------------------------
--
-- 1:1 satellite of entities(kind='document'). Identity is the repo-relative
-- path; the embeddable text lives in `chunks`, which 0006 created ahead of any
-- data so the HNSW index would already exist before there was anything to
-- rebuild it over.
--
-- `mentions` holds the raw prose references found in the document
-- ({paths, identifiers}). Identifiers are resolved into
-- entity_links(relation='MENTIONS') once per index run, when the whole symbol
-- table for the run is settled. Paths stay here under a GIN index instead: a
-- file is not an entity in this schema, so the only available link target
-- would be every symbol in the file, which turns one prose reference to
-- src/graph.js into a dozen link rows and drowns the specific ones. "Which
-- docs mention this file?" is then one indexed containment query.
CREATE TABLE IF NOT EXISTS documents (
  entity_id    BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  org_id       INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id      BIGINT REFERENCES files(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  doc_type     TEXT NOT NULL,   -- adr | readme | changelog | contributing | guide | note
  title        TEXT,
  frontmatter  JSONB NOT NULL DEFAULT '{}'::jsonb,
  adr          JSONB,           -- { status, context, decision, consequences }
  mentions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL,
  chunk_count  INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS documents_type_idx     ON documents (project_id, doc_type);
CREATE INDEX IF NOT EXISTS documents_mentions_idx ON documents USING gin (mentions);
