-- Support the namespace-suffix edge-resolution pass in indexer.js.
--
-- That pass joins on regexp_replace(name, '^.*\\', '') -- the symbol name
-- with its namespace stripped -- which is not indexable as written and would
-- otherwise sequential-scan every symbol in the project on each index run.
-- A functional index over the same expression makes it a lookup.
--
-- Partial: only namespaced names participate, which is a small minority of
-- rows, so the index stays cheap for JS/TS-only projects.

CREATE INDEX IF NOT EXISTS symbols_shortname_idx
  ON symbols (project_id, (regexp_replace(name, '^.*\\', '')))
  WHERE name LIKE '%\%';
