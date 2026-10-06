-- Support the method-suffix edge-resolution pass and doc-mention resolution
-- in indexer.js.
--
-- Both used to match a bare name against `Class::name` with
-- `name LIKE '%::' || other.name`: a leading wildcard over a per-row pattern,
-- which no index can serve, so Postgres nested-looped every unresolved edge
-- against every method. On a WordPress install (226k unresolved edges x 31k
-- methods) that one UPDATE ran for hours. It was also wrong: `_` is a LIKE
-- wildcard, so a call to `get_option` matched `Cfg::getXoption`.
--
-- The queries now compare the name with everything up to the last `::`
-- stripped; these functional indexes over the same expression make that a
-- lookup. Partial, like symbols_shortname_idx, so only rows that can match
-- pay for them.

CREATE INDEX IF NOT EXISTS symbols_method_short_idx
  ON symbols (project_id, (regexp_replace(name, '^.*::', '')))
  WHERE kind = 'method';

CREATE INDEX IF NOT EXISTS entities_symbol_title_idx
  ON entities (project_id, title)
  WHERE kind = 'symbol' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS entities_symbol_short_idx
  ON entities (project_id, (regexp_replace(title, '^.*::', '')))
  WHERE kind = 'symbol' AND deleted_at IS NULL AND title LIKE '%::%';
