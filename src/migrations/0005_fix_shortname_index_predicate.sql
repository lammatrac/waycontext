-- Fix the partial-index predicate added in 0004.
--
-- It was written as `WHERE name LIKE '%\%'`, but in a LIKE pattern the
-- backslash is the escape character, so `\%` means "a literal percent sign"
-- -- the predicate matched names containing '%' rather than names containing
-- a namespace separator, so the index covered almost no rows and the
-- namespace-suffix resolution pass fell back to a sequential scan.
--
-- The correct pattern doubles the backslash: `'%\\%'`.

DROP INDEX IF EXISTS symbols_shortname_idx;

CREATE INDEX IF NOT EXISTS symbols_shortname_idx
  ON symbols (project_id, (regexp_replace(name, '^.*\\', '')))
  WHERE name LIKE '%\\%';
