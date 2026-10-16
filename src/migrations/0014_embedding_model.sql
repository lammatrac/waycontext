-- Record which embedding model produced each stored vector.
--
-- Vectors from different models live in unrelated spaces: a cosine distance
-- between a voyage-code-3 symbol and a voyage-code-4 query is noise. Switching
-- VOYAGE_MODEL left every earlier project embedded with the old model, and
-- vector search silently compared across the two -- garbage rankings on small
-- projects, and on large ones an HNSW walk that never reached the new space.
--
-- New writes stamp the row itself (embedding_model / message_embedding_model).
-- Rows written before this migration are NOT rewritten: an UPDATE of ~1.5M
-- symbol rows re-inserts every one of them into the HNSW index, which takes
-- hours. Instead the project carries the model all of its legacy rows used,
-- and readers resolve COALESCE(row.embedding_model, projects.legacy_embedding_model).
--
-- legacy_embedding_model is only set where embedding_usage shows a project's
-- document embeddings came from exactly one model. A project embedded with
-- two models is left NULL: its legacy rows are of unknown provenance, which
-- readers treat as stale and `waycontext reembed` replaces.

ALTER TABLE symbols  ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE chunks   ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE commits  ADD COLUMN IF NOT EXISTS message_embedding_model TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS legacy_embedding_model TEXT;

UPDATE projects p
   SET legacy_embedding_model = single.model_id
  FROM (
    SELECT project_id, min(provider || ':' || model) AS model_id
      FROM embedding_usage
     WHERE project_id IS NOT NULL AND input_type = 'document'
     GROUP BY project_id
    HAVING count(DISTINCT provider || ':' || model) = 1
  ) single
 WHERE p.id = single.project_id;
