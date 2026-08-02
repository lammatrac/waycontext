-- Introduce an owning organisation for projects.
--
-- Nothing user-visible changes: a single 'default' org is created and every
-- existing project is assigned to it. The point is to add the tenant column
-- while there is exactly one tenant and the backfill is free -- doing this
-- after other people have data is a genuinely painful migration.
--
-- Read paths need no changes: everything already filters by project_id, which
-- becomes org-scoped transitively. Only project lookup/creation gains an org.

CREATE TABLE IF NOT EXISTS orgs (
  id         SERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,     -- stable identifier used by config/env
  name       TEXT NOT NULL,            -- display name
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO orgs (slug, name) VALUES ('default', 'Default')
  ON CONFLICT (slug) DO NOTHING;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id INT REFERENCES orgs(id) ON DELETE CASCADE;
UPDATE projects SET org_id = (SELECT id FROM orgs WHERE slug = 'default') WHERE org_id IS NULL;
ALTER TABLE projects ALTER COLUMN org_id SET NOT NULL;

-- Project names are unique per org, not globally: two orgs may both have an
-- "api" project. Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guard.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_name_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_org_name_key'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_org_name_key UNIQUE (org_id, name);
  END IF;
END
$$;

-- Denormalised onto usage rows so cost attribution survives project deletion.
-- projects.project_id is deliberately ON DELETE SET NULL there (billing history
-- outlives a project), which means the org would otherwise be unrecoverable.
ALTER TABLE embedding_usage ADD COLUMN IF NOT EXISTS org_id INT REFERENCES orgs(id) ON DELETE SET NULL;
UPDATE embedding_usage eu
   SET org_id = p.org_id
  FROM projects p
 WHERE eu.project_id = p.id AND eu.org_id IS NULL;
CREATE INDEX IF NOT EXISTS embedding_usage_org_idx ON embedding_usage (org_id);
