-- Hash of the exact text a vector was embedded from, so an identical text can
-- reuse that vector instead of a provider call.
--
-- WordPress installs share most of their code: the same plugin file at the same
-- relative path produces byte-identical embedding text on every site. Measured
-- across this machine's 17 projects needing a model change, ~132M tokens of
-- text held only ~63M tokens of distinct text. The indexer looks pending texts
-- up by (embed_hash, embedding_model) and only sends the misses.
--
-- Nullable with no default, so ADD COLUMN is a catalog-only change -- no
-- rewrite of 1.4M symbol rows. Rows written before this migration simply have
-- no hash and are never matched; partial indexes keep those out of the index.

ALTER TABLE symbols ADD COLUMN IF NOT EXISTS embed_hash TEXT;
ALTER TABLE chunks  ADD COLUMN IF NOT EXISTS embed_hash TEXT;

CREATE INDEX IF NOT EXISTS symbols_embed_hash_idx
  ON symbols (embed_hash, embedding_model) WHERE embed_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_embed_hash_idx
  ON chunks (embed_hash, embedding_model) WHERE embed_hash IS NOT NULL;
