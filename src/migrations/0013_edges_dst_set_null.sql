-- Keep call edges alive when their target symbol's row is replaced.
--
-- Re-indexing a file deletes and re-inserts its symbols. With
-- edges.dst ON DELETE CASCADE, that also deleted every edge *pointing at*
-- those symbols from other files -- and since those callers' files were
-- unchanged and hash-skipped, their edges were never re-created: editing a
-- function silently dropped its callers from get_callers until each caller's
-- file was itself edited.
--
-- ON DELETE SET NULL turns those edges back into unresolved ones (dst_name is
-- kept), which the next resolution pass re-links -- in the same run -- to the
-- re-inserted symbol, or leaves unresolved if the target really is gone.
-- edges_dst_idx (0001) keeps the SET NULL lookup an index scan.
--
-- src keeps CASCADE: an edge whose calling symbol is gone has nothing to hang
-- from, and the caller's own file rewrite replaces it anyway.

ALTER TABLE edges
  DROP CONSTRAINT IF EXISTS edges_dst_fkey,
  ADD CONSTRAINT edges_dst_fkey
    FOREIGN KEY (dst) REFERENCES symbols(id) ON DELETE SET NULL;
