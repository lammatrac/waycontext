-- Attribute pre-org embedding_usage rows whose project is already gone.
--
-- 0002 backfilled org_id by joining to projects, which misses rows where
-- project_id is NULL -- embedding_usage deliberately uses ON DELETE SET NULL
-- so cost history outlives a deleted project. Those rows would then be
-- filtered out of `codecontext usage`, silently shrinking historical totals.
--
-- Guarded on there being exactly one org: at upgrade time that is true by
-- construction, and the rows can only belong to it. With more than one org
-- the attribution would be a guess, so leave them alone and let the totals
-- be explicitly incomplete rather than quietly wrong.

DO $$
DECLARE
  only_org INT;
BEGIN
  IF (SELECT count(*) FROM orgs) = 1 THEN
    SELECT id INTO only_org FROM orgs;
    UPDATE embedding_usage SET org_id = only_org WHERE org_id IS NULL;
  END IF;
END
$$;
