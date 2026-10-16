-- Drop the HNSW indexes on symbols.embedding and chunks.embedding.
--
-- Every vector query is scoped to one project, and since 0014 to one embedding
-- model as well. A single HNSW graph over every project's vectors cannot serve
-- that: pgvector walks hnsw.ef_search (40) global neighbours and applies the
-- project filter afterwards, so any project that wasn't globally nearest got
-- zero rows back. Search now ranks a project's rows exactly through the
-- project_id btree (src/graph.js#vectorCandidates), and nothing reads these
-- indexes -- while every embedding write still paid to insert into them, and
-- symbols_embedding_idx alone held ~7 GB.

DROP INDEX IF EXISTS symbols_embedding_idx;
DROP INDEX IF EXISTS chunks_embedding_idx;
