-- Receiver-aware method resolution in indexer.js.
--
-- A PHP call like `$this->save()` used to be stored as a bare `save`, and the
-- resolver linked it to an arbitrary one of every class's `save` -- on a
-- WordPress install, half of all method calls matched ~40 candidates each.
-- edges.receiver keeps what the call is made on ("$this", "self", "static",
-- "parent", a class name, or "?" for an unknown object) so the resolver can
-- prefer the caller's own class, then its parents, then the named class, and
-- otherwise link only a unique match.
--
-- files.edges_version records which parser output a file's edges came from.
-- Existing rows default to 0, so the next index run re-derives edges for files
-- whose content hash is unchanged -- without that they would keep their old,
-- receiver-less edges (and their guessed links) until the file was next
-- edited. Only edges are rebuilt; symbols and their embeddings are left alone.
--
-- Both are metadata-only ADD COLUMNs (constant default), so this is instant
-- even on large tables.

ALTER TABLE edges ADD COLUMN IF NOT EXISTS receiver TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS edges_version INT NOT NULL DEFAULT 0;
