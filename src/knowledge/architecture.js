/**
 * Read queries over the derived plane: modules, their metrics and dependencies,
 * co-change and bug clusters.
 *
 * Everything here reads materialised rows and does no aggregation of its own,
 * which is the entire justification for materialising them. If a query in this
 * file starts needing a window function over commit_files, it belongs in
 * metrics.js and a derivation, not here.
 */
import { pool, getProject } from "../db.js";
import { config } from "../config.js";
import { resolveTarget } from "./history.js";

async function requireProject(name) {
  const project = await getProject(name);
  if (!project) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return project;
}

/**
 * Whether a project's risk numbers mean anything more than churn.
 *
 * `is_fix` is keyword-based, so a team that never writes "fix" in a subject line
 * has no defect signal at all, and every caller needs to know that before it
 * presents a ranking as "risk".
 */
async function riskBasisFor(projectId) {
  const res = await pool.query(
    `SELECT bool_or(fix_commits > 0) AS any_fix FROM module_metrics WHERE project_id = $1`,
    [projectId]
  );
  return res.rows[0]?.any_fix ? "churn_x_defects" : "churn_only";
}

/** Has anything been derived for this project yet? */
async function derivedState(projectId) {
  const res = await pool.query(
    `SELECT kind, row_count, computed_at, duration_ms FROM derived_state WHERE project_id = $1`,
    [projectId]
  );
  return res.rows;
}

const SORTS = {
  risk: "COALESCE(mm.risk, 0) DESC, m.loc DESC",
  churn: "COALESCE(mm.churn, 0) DESC, m.loc DESC",
  loc: "m.loc DESC",
  path: "m.path ASC",
};

/**
 * Every module of a project with its metrics, most at-risk first.
 *
 * @param {string} projectName
 * @param {{limit?:number, sort?:'risk'|'churn'|'loc'|'path'}} opts
 */
export async function getModules(projectName, opts = {}) {
  const project = await requireProject(projectName);
  const sort = SORTS[opts.sort] ?? SORTS.risk;
  const limit = opts.limit ?? 30;

  const res = await pool.query(
    `SELECT m.id, m.path, m.name, m.depth, m.file_count, m.loc, m.symbol_count,
            mm.window_days, mm.commits, mm.fix_commits, mm.authors,
            mm.churn, mm.defect_density, mm.risk,
            (SELECT count(*) FROM module_deps d WHERE d.src_module_id = m.id) AS depends_on,
            (SELECT count(*) FROM module_deps d WHERE d.dst_module_id = m.id) AS depended_on_by
       FROM modules m
       LEFT JOIN module_metrics mm ON mm.module_id = m.id
      WHERE m.project_id = $1
      ORDER BY ${sort}
      LIMIT $2`,
    [project.id, limit]
  );

  const state = await derivedState(project.id);
  return {
    project: project.name,
    module_depth: config.moduleDepth,
    risk_basis: await riskBasisFor(project.id),
    // An empty list means "not derived yet" far more often than "no modules",
    // and the difference is a re-index.
    derived: state.length ? state : null,
    modules: res.rows.map((r) => ({
      ...r,
      defect_density: r.defect_density == null ? null : Number(r.defect_density.toFixed(3)),
    })),
  };
}

/**
 * One module in full: metrics, dependencies both ways, owners, its largest
 * files and the bug clusters that land in it.
 */
export async function getModule(projectName, modulePath) {
  const project = await requireProject(projectName);
  if (!modulePath || !modulePath.trim()) throw new Error("A module path is required");
  const wanted = modulePath.trim().replace(/\/+$/, "") || ".";

  const mod = await pool.query(
    `SELECT m.*, mm.window_days, mm.commits, mm.fix_commits, mm.authors,
            mm.additions, mm.deletions, mm.churn, mm.defect_density, mm.risk
       FROM modules m LEFT JOIN module_metrics mm ON mm.module_id = m.id
      WHERE m.project_id = $1 AND m.path = $2`,
    [project.id, wanted]
  );
  if (!mod.rows.length) {
    const near = await pool.query(
      `SELECT path FROM modules WHERE project_id = $1 ORDER BY path LIMIT 20`,
      [project.id]
    );
    throw new Error(
      `Module "${wanted}" not found. Known modules: ${near.rows.map((r) => r.path).join(", ") || "(none derived yet)"}`
    );
  }
  const module = mod.rows[0];

  const [dependsOn, dependedOnBy, owners, files, clusters] = await Promise.all([
    pool.query(
      `SELECT m2.path, m2.name, d.edge_count
         FROM module_deps d JOIN modules m2 ON m2.id = d.dst_module_id
        WHERE d.src_module_id = $1 ORDER BY d.edge_count DESC`,
      [module.id]
    ),
    pool.query(
      `SELECT m2.path, m2.name, d.edge_count
         FROM module_deps d JOIN modules m2 ON m2.id = d.src_module_id
        WHERE d.dst_module_id = $1 ORDER BY d.edge_count DESC`,
      [module.id]
    ),
    pool.query(
      `SELECT p.display_name, p.canonical_email, o.share, o.commits, o.last_touched_at
         FROM ownership o JOIN people p ON p.entity_id = o.person_entity_id
        WHERE o.module_id = $1 ORDER BY o.weight DESC LIMIT 8`,
      [module.id]
    ),
    pool.query(
      `SELECT f.path, f.language, f.loc
         FROM module_members mb JOIN files f ON f.id = mb.file_id
        WHERE mb.module_id = $1 ORDER BY f.loc DESC NULLS LAST LIMIT 20`,
      [module.id]
    ),
    pool.query(
      `SELECT id, label, size, method, first_seen_at, last_seen_at
         FROM bug_clusters WHERE module_id = $1 ORDER BY size DESC LIMIT 10`,
      [module.id]
    ),
  ]);

  return {
    project: project.name,
    module: {
      path: module.path, name: module.name, depth: module.depth,
      file_count: module.file_count, loc: module.loc, symbol_count: module.symbol_count,
    },
    metrics: module.window_days == null ? null : {
      window_days: module.window_days,
      commits: module.commits, fix_commits: module.fix_commits, authors: module.authors,
      additions: module.additions, deletions: module.deletions, churn: module.churn,
      defect_density: Number(Number(module.defect_density).toFixed(3)),
      risk: module.risk,
      risk_basis: await riskBasisFor(project.id),
    },
    depends_on: dependsOn.rows,
    depended_on_by: dependedOnBy.rows,
    owners: owners.rows.map((o) => ({
      ...o, share: o.share == null ? null : Number(Number(o.share).toFixed(3)),
    })),
    largest_files: files.rows,
    bug_clusters: clusters.rows,
  };
}

/**
 * What else changes when this changes.
 *
 * Takes the same free-form target as get_history: a path, a directory or a
 * symbol name. A symbol resolves through the identity plane, so asking about a
 * function that has been moved still finds the coupling recorded against its
 * old path.
 */
export async function getCochange(projectName, target, limit = 15) {
  const project = await requireProject(projectName);
  // No scope noun: get_cochange rejects an omitted target outright below, so the
  // "omit the target for project-wide X" half of the message never applies here.
  const scope = await resolveTarget(project, target, "co-change");
  if (!scope.paths || !scope.paths.length) {
    throw new Error("get_cochange needs a file, directory or symbol to compare against");
  }

  const res = await pool.query(
    `SELECT CASE WHEN c.path_a = ANY($2::text[]) THEN c.path_b ELSE c.path_a END AS path,
            c.pair_commits, c.confidence, c.lift,
            CASE WHEN c.path_a = ANY($2::text[]) THEN c.a_commits ELSE c.b_commits END AS target_commits
       FROM cochange c
      WHERE c.project_id = $1
        AND (c.path_a = ANY($2::text[]) OR c.path_b = ANY($2::text[]))
        -- A pair whose other side is also in scope is the target coupling to
        -- itself, which tells the caller nothing they didn't ask with.
        AND NOT (c.path_a = ANY($2::text[]) AND c.path_b = ANY($2::text[]))
      ORDER BY c.confidence DESC, c.pair_commits DESC
      LIMIT $3`,
    [project.id, scope.paths, limit]
  );

  return {
    project: project.name,
    target: { kind: scope.kind, value: scope.value, paths: scope.paths },
    min_pair_commits: config.cochangeMinPairCommits,
    coupled: res.rows.map((r) => ({
      ...r,
      confidence: Number(Number(r.confidence).toFixed(3)),
      lift: r.lift == null ? null : Number(Number(r.lift).toFixed(2)),
    })),
  };
}

/** Recurring themes across fix commits, largest cluster first. */
export async function getBugClusters(projectName, limit = 10) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT bc.id, bc.label, bc.terms, bc.size, bc.method,
            bc.first_seen_at, bc.last_seen_at, m.path AS module_path
       FROM bug_clusters bc LEFT JOIN modules m ON m.id = bc.module_id
      WHERE bc.project_id = $1 ORDER BY bc.size DESC, bc.id LIMIT $2`,
    [project.id, limit]
  );

  // A few example subjects per cluster: a label of three terms is not enough to
  // judge whether a cluster is real, and judging that is the point.
  const clusters = [];
  for (const c of res.rows) {
    const examples = await pool.query(
      `SELECT co.short_sha, co.subject, co.authored_at, bm.similarity
         FROM bug_cluster_members bm JOIN commits co ON co.entity_id = bm.commit_entity_id
        WHERE bm.cluster_id = $1 ORDER BY co.authored_at DESC NULLS LAST LIMIT 5`,
      [c.id]
    );
    clusters.push({ ...c, examples: examples.rows });
  }

  return {
    project: project.name,
    // "embedding" clusters are semantic; "terms" clusters are (module, term)
    // buckets from a run with embeddings off. Never present one as the other.
    method: clusters[0]?.method ?? null,
    threshold: config.bugClusterThreshold,
    min_size: config.bugClusterMinSize,
    // Same reason get_modules reports this: an empty list means "derived, and
    // nothing recurs" far more often than "no fix commits", but without the
    // watermark row it is indistinguishable from "never derived" -- and the two
    // have completely different fixes (nothing, versus re-index).
    derived: (await derivedState(project.id)).filter((r) => r.kind === "clusters")[0] ?? null,
    clusters,
  };
}
