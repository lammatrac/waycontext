import { pool } from "./pool.js";
import { config } from "./config.js";
import { applyMigrations } from "./migrate.js";

export { pool };

/** Serialize a JS number array into pgvector literal format. */
export function toVector(arr) {
  return "[" + arr.map((x) => Number(x).toPrecision(8)).join(",") + "]";
}

/**
 * Bring the database up to the current schema.
 *
 * The DDL itself lives in src/migrations/*.sql; this only installs the
 * pgvector extension (which the baseline's `vector` columns depend on) and
 * hands off to the migration runner. Keeping the name and signature means
 * every existing call site -- cli.js `init-db`, cli.js `index`, server.js
 * startup, install.sh's `npm run init-db`, and the test suites -- is
 * unchanged.
 *
 * @param {(msg: string) => void} [log] optional progress sink
 */
export async function initDb(log) {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  return applyMigrations(log);
}

/**
 * Resolve the org every command operates within, memoized per process.
 *
 * A local install has exactly one org ('default'), so this is effectively a
 * constant today. It exists as a lookup rather than a hardcoded 1 so that the
 * hosted and on-premise builds can scope by ORG_SLUG without touching any
 * query, and so nothing depends on the default org happening to have id 1.
 */
let orgIdPromise = null;
export function currentOrgId() {
  orgIdPromise ??= (async () => {
    const slug = config.orgSlug;
    const res = await pool.query(
      `INSERT INTO orgs (slug, name) VALUES ($1, $1)
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id`,
      [slug]
    );
    return res.rows[0].id;
  })().catch((e) => {
    orgIdPromise = null; // don't cache a transient failure
    throw e;
  });
  return orgIdPromise;
}

/** Reset the memoized org id. Tests use this after changing ORG_SLUG. */
export function resetOrgCache() {
  orgIdPromise = null;
}

export async function getOrCreateProject(name, rootPath, orgId) {
  orgId ??= await currentOrgId();
  const res = await pool.query(
    `INSERT INTO projects (org_id, name, root_path) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, name) DO UPDATE SET root_path = EXCLUDED.root_path
     RETURNING *`,
    [orgId, name, rootPath]
  );
  return res.rows[0];
}

export async function getProject(name, orgId) {
  orgId ??= await currentOrgId();
  const res = await pool.query(
    `SELECT * FROM projects WHERE org_id = $1 AND name = $2`,
    [orgId, name]
  );
  return res.rows[0] || null;
}

export async function listProjects(orgId) {
  orgId ??= await currentOrgId();
  const res = await pool.query(
    `SELECT p.*,
       (SELECT count(*) FROM files f WHERE f.project_id = p.id)   AS file_count,
       (SELECT count(*) FROM symbols s WHERE s.project_id = p.id) AS symbol_count,
       (SELECT count(*) FROM edges e WHERE e.project_id = p.id)   AS edge_count
     FROM projects p WHERE p.org_id = $1 ORDER BY p.name`,
    [orgId]
  );
  return res.rows;
}

export async function deleteProject(name, orgId) {
  orgId ??= await currentOrgId();
  const res = await pool.query(
    `DELETE FROM projects WHERE org_id = $1 AND name = $2 RETURNING *`,
    [orgId, name]
  );
  return res.rows[0] || null;
}

/** Log one embedding API call for token usage / cost reporting. */
export async function recordEmbeddingUsage(projectId, provider, model, inputType, tokens) {
  if (!tokens) return;
  await pool.query(
    `INSERT INTO embedding_usage (org_id, project_id, provider, model, input_type, tokens)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [await currentOrgId(), projectId, provider, model, inputType, tokens]
  );
}

/** Aggregate embedding token usage, optionally scoped to one project. */
export async function getEmbeddingUsage(projectName) {
  const params = [await currentOrgId()];
  let where = "WHERE eu.org_id = $1";
  if (projectName) {
    const project = await getProject(projectName);
    if (!project) throw new Error(`Project "${projectName}" not found.`);
    where += " AND eu.project_id = $2";
    params.push(project.id);
  }
  const res = await pool.query(
    `SELECT eu.provider, eu.model, eu.input_type,
            COUNT(*)::int AS requests, COALESCE(SUM(eu.tokens), 0)::bigint AS tokens,
            MIN(eu.created_at) AS first_seen, MAX(eu.created_at) AS last_seen
     FROM embedding_usage eu
     ${where}
     GROUP BY eu.provider, eu.model, eu.input_type
     ORDER BY eu.provider, eu.model, eu.input_type`,
    params
  );
  return res.rows;
}
