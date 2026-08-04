/**
 * Queries over the ingested git history: `get_history` and `who_owns`.
 *
 * Both take a free-form target -- a file path, a directory, a symbol name, or
 * nothing at all -- because that is how the question actually arrives from an
 * agent ("who owns the indexer?"), and forcing the caller to know which of
 * those it has just moves the guessing one layer up.
 */
import { pool, getProject } from "../db.js";
import { config } from "../config.js";

async function requireProject(name) {
  const project = await getProject(name);
  if (!project) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return project;
}

/**
 * Work out which file paths a target refers to.
 *
 * Resolution order is most-specific first: an exact file, then a symbol, then
 * a directory prefix. A symbol resolves to its current file AND every file it
 * used to live in, read from symbol_aliases -- which is the payoff for
 * maintaining the identity plane at all. Ask about `searchCode` and you get
 * its history from before it was moved into src/graph.js, not a truncated log
 * that starts at the move.
 *
 * `scope` names what an omitted target means for the caller. This function is
 * shared by history, rules and the architecture queries, and the not-found
 * message ends by telling the user they may omit the target -- which read as
 * "omit the target for project-wide history" even when they had asked for rules.
 *
 * @param {string} scope noun for the project-wide fallback, e.g. "history"
 * @returns {Promise<{kind:string, value:string|null, paths:string[]|null}>}
 *   paths === null means project-wide.
 */
export async function resolveTarget(project, target, scope = "history") {
  if (!target || !target.trim()) return { kind: "project", value: null, paths: null };
  const value = target.trim();

  const exact = await pool.query(
    `SELECT path FROM files WHERE project_id = $1 AND path = $2`,
    [project.id, value]
  );
  if (exact.rows.length) return { kind: "file", value, paths: [value] };

  // Current location comes from `files`, which is always populated; former
  // locations come from symbol_aliases, which is populated only once the
  // symbol has actually moved. Deliberately not read from entities.data: this
  // way a symbol indexed before the identity plane existed (entity_id still
  // NULL, backfill not run) still resolves to its file.
  const symbol = await pool.query(
    `SELECT DISTINCT p.path FROM (
        SELECT f.path
          FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.project_id = $1 AND (s.name = $2 OR s.name LIKE '%::' || $2)
        UNION
        SELECT a.path
          FROM symbols s
          JOIN symbol_aliases a ON a.entity_id = s.entity_id
         WHERE s.project_id = $1 AND (s.name = $2 OR s.name LIKE '%::' || $2)
     ) p WHERE p.path IS NOT NULL`,
    [project.id, value]
  );
  if (symbol.rows.length) {
    return { kind: "symbol", value, paths: symbol.rows.map((r) => r.path) };
  }

  // A directory, or any path prefix. Matched against commit_files rather than
  // files so a directory that has since been deleted still has a history.
  const prefix = value.replace(/\/+$/, "");
  const dir = await pool.query(
    `SELECT DISTINCT path FROM commit_files
      WHERE project_id = $1 AND (path = $2 OR path LIKE $2 || '/%')
      LIMIT 5000`,
    [project.id, prefix]
  );
  if (dir.rows.length) {
    return { kind: "path", value, paths: dir.rows.map((r) => r.path) };
  }

  throw new Error(
    `No file, symbol or directory named "${value}" in project "${project.name}". ` +
    `Pass a path relative to the project root, a symbol name, or omit the target for project-wide ${scope}.`
  );
}

const COMMIT_ISSUES = `
  (SELECT json_agg(json_build_object(
            'tracker', i.tracker, 'key', i.external_key, 'url', i.url,
            'relation', el.relation, 'known', e.source <> 'inferred')
          ORDER BY i.tracker, i.external_key)
     FROM entity_links el
     JOIN issues i   ON i.entity_id = el.dst_id
     JOIN entities e ON e.id = el.dst_id
    WHERE el.src_id = c.entity_id AND el.relation IN ('FIXES', 'REFERENCES'))`;

/**
 * Commits touching a target, newest first, with the issues they reference.
 *
 * @param {string} projectName
 * @param {string} [target] file path, symbol name or directory; omit for the whole project
 * @param {number} [limit]
 */
export async function getHistory(projectName, target, limit = 20) {
  const project = await requireProject(projectName);
  const scope = await resolveTarget(project, target);
  const scoped = scope.paths !== null;

  const params = scoped ? [project.id, scope.paths, limit] : [project.id, limit];
  const limitParam = scoped ? "$3" : "$2";
  const paths = scoped
    ? `(SELECT array_agg(cf.path ORDER BY cf.path) FROM commit_files cf
         WHERE cf.commit_entity_id = c.entity_id AND cf.path = ANY($2))`
    : `(SELECT array_agg(x.path) FROM (
           SELECT cf.path FROM commit_files cf
            WHERE cf.commit_entity_id = c.entity_id
            ORDER BY cf.additions + cf.deletions DESC, cf.path LIMIT 5) x)`;

  const res = await pool.query(
    `SELECT c.sha, c.short_sha, c.author_name, c.author_email, c.authored_at,
            c.subject, c.is_fix, c.is_revert, c.is_merge,
            c.files_changed, c.insertions, c.deletions,
            ${paths} AS paths,
            ${COMMIT_ISSUES} AS issues
       FROM commits c
       ${scoped ? `JOIN (SELECT DISTINCT commit_entity_id AS cid FROM commit_files
                          WHERE project_id = $1 AND path = ANY($2)) t
                     ON t.cid = c.entity_id` : ""}
      WHERE c.project_id = $1
      ORDER BY c.authored_at DESC NULLS LAST
      LIMIT ${limitParam}`,
    params
  );

  const summary = await pool.query(
    `SELECT count(*)::int AS total_commits,
            count(*) FILTER (WHERE c.is_fix)::int AS fix_commits,
            count(*) FILTER (WHERE c.is_revert)::int AS revert_commits,
            count(DISTINCT coalesce(c.author_email, c.author_name))::int AS contributors,
            min(c.authored_at) AS first_commit,
            max(c.authored_at) AS last_commit
       FROM commits c
       ${scoped ? `JOIN (SELECT DISTINCT commit_entity_id AS cid FROM commit_files
                          WHERE project_id = $1 AND path = ANY($2)) t
                     ON t.cid = c.entity_id` : ""}
      WHERE c.project_id = $1`,
    scoped ? [project.id, scope.paths] : [project.id]
  );

  return {
    target: { kind: scope.kind, value: scope.value, paths: scope.paths },
    summary: summary.rows[0],
    commits: res.rows.map((r) => ({ ...r, issues: r.issues ?? [], paths: r.paths ?? [] })),
  };
}

/**
 * Who has been working on this, weighted towards recent work.
 *
 * A plain commit count answers "who wrote most of this historically", which is
 * the wrong question: the person to ask is whoever still has it in their head.
 * Each commit contributes exp(-ln2 * age / half-life), so a commit from one
 * half-life ago counts half as much as one from today.
 *
 * Merges are excluded -- they inflate whoever happens to run the integrations
 * without telling you anything about who understands the code.
 */
export async function whoOwns(projectName, target, limit = 10) {
  const project = await requireProject(projectName);
  const scope = await resolveTarget(project, target);
  const scoped = scope.paths !== null;
  const halfLife = Math.max(config.ownershipHalfLifeDays, 1);

  const params = scoped
    ? [project.id, scope.paths, halfLife, limit]
    : [project.id, halfLife, limit];
  const p = (n) => `$${scoped ? n : n - 1}`;

  const touched = scoped
    ? `SELECT cf.commit_entity_id AS cid,
              sum(cf.additions)::int AS adds, sum(cf.deletions)::int AS dels
         FROM commit_files cf
        WHERE cf.project_id = $1 AND cf.path = ANY($2)
        GROUP BY 1`
    : `SELECT c.entity_id AS cid, c.insertions AS adds, c.deletions AS dels
         FROM commits c WHERE c.project_id = $1`;

  const res = await pool.query(
    `WITH touched AS (${touched}),
     per_commit AS (
       SELECT coalesce(c.author_email, 'name:' || lower(coalesce(c.author_name, 'unknown'))) AS identity,
              c.author_name, c.author_email, c.authored_at, c.subject, c.is_fix,
              t.adds, t.dels,
              exp(-ln(2) * GREATEST(extract(epoch FROM (now() - c.authored_at)), 0)
                  / 86400.0 / ${p(3)}) AS weight,
              row_number() OVER (
                PARTITION BY coalesce(c.author_email, 'name:' || lower(coalesce(c.author_name, 'unknown')))
                ORDER BY c.authored_at DESC
              ) AS recency_rank
         FROM touched t
         JOIN commits c ON c.entity_id = t.cid
        WHERE NOT c.is_merge
     )
     SELECT max(author_name) AS name,
            max(author_email) AS email,
            count(*)::int AS commits,
            count(*) FILTER (WHERE is_fix)::int AS fix_commits,
            coalesce(sum(adds), 0)::int AS insertions,
            coalesce(sum(dels), 0)::int AS deletions,
            min(authored_at) AS first_touch,
            max(authored_at) AS last_touch,
            round(sum(weight)::numeric, 4) AS score,
            max(subject) FILTER (WHERE recency_rank = 1) AS last_change
       FROM per_commit
      GROUP BY identity
      ORDER BY sum(weight) DESC
      LIMIT ${p(4)}`,
    params
  );

  const total = res.rows.reduce((sum, r) => sum + Number(r.score), 0);
  return {
    target: { kind: scope.kind, value: scope.value, paths: scope.paths },
    half_life_days: halfLife,
    owners: res.rows.map((r) => ({
      ...r,
      score: Number(r.score),
      // Share of the ranked owners' weight, not of all history: it answers
      // "how dominant is the top name" without pretending the tail is complete.
      share: total > 0 ? +(Number(r.score) / total).toFixed(3) : 0,
    })),
  };
}
