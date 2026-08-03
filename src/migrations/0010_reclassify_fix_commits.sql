-- Force one re-read of git history, so every commit's `is_fix` is recomputed.
--
-- The classifier changed: it used to match "fix" anywhere in the subject, which
-- counted "feat: ... and past fixes" as a defect. That was a tolerable
-- imprecision while is_fix was only a filter on `get_history`; it stopped being
-- tolerable in Phase 4, where defect_density divides by it and bug clusters are
-- built from it.
--
-- is_fix is computed in JS at ingest time, so there is no SQL expression to
-- recompute it with. Instead, clear the ingestion watermark: history ingestion
-- is an idempotent upsert keyed on (project_id, sha), so the next index re-reads
-- the log and rewrites every commit row with the corrected flag. One extra full
-- history pass per project, once.
UPDATE projects SET last_history_sha = NULL;

-- The derived watermark is built from last_history_sha, which will come back to
-- the same value it already had -- so without this, metrics and clusters would
-- be skipped as up-to-date and keep serving numbers computed from the old
-- classification.
DELETE FROM derived_state;
