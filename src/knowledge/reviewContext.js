/**
 * `review_context`: everything worth knowing before reading or continuing a
 * change.
 *
 * Defaults to the working tree rather than requiring paths, because the question
 * is nearly always about what is on disk right now, and making the caller run
 * git themselves just moves the work one layer up.
 */
import picomatch from "picomatch";
import { pool, getProject } from "../db.js";
import { getWorkingTreeChanges } from "../gitDiff.js";
import { getRules } from "./rules.js";

/**
 * @param {string} projectName
 * @param {string[]|string|null} [paths] explicit paths, or a comma-separated
 *   string as the CLI passes it; omit for the working-tree diff.
 */
export async function reviewContext(projectName, paths = null) {
  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found. Run index_project first.`);

  const list = Array.isArray(paths)
    ? paths.map((p) => String(p).trim()).filter(Boolean)
    : typeof paths === "string" && paths.trim()
      ? paths.split(",").map((p) => p.trim()).filter(Boolean)
      : await getWorkingTreeChanges(project.root_path);

  if (!list.length) {
    return {
      paths: [],
      rules: [],
      memories: [],
      recent_fixes: [],
      note: "No changed paths in the working tree; pass `paths` to ask about specific files.",
    };
  }

  // Rules are collected per path and de-duplicated, so a rule scoped to two of
  // the changed directories is reported once. A path that resolves to nothing
  // (a brand-new untracked file) still gets its rules, because matching is done
  // against the literal path rather than against the index.
  const activeRules = (await getRules(projectName)).rules;
  const rules = activeRules.filter((r) => {
    if (!r.scope) return true;
    const match = picomatch(r.scope);
    return list.some((p) => match(p) || p === r.scope);
  });

  const memoryRows = await pool.query(
    `SELECT m.entity_id AS id, e.natural_key AS key, m.kind, m.content, m.scope,
            m.pinned, m.created_at
       FROM memories m JOIN entities e ON e.id = m.entity_id
      WHERE m.project_id = $1 AND e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM memories s WHERE s.supersedes = m.entity_id)
      ORDER BY m.pinned DESC, m.updated_at DESC`,
    [project.id]
  );
  // An unscoped memory rides along only when pinned: everything anyone ever
  // remembered about the project is not review context, it is noise.
  const memories = memoryRows.rows.filter((m) => {
    if (!m.scope) return m.pinned;
    const match = picomatch(m.scope);
    return list.some((p) => match(p) || p === m.scope);
  });

  const fixes = await pool.query(
    `SELECT DISTINCT c.sha, c.short_sha, c.subject, c.authored_at, c.author_name
       FROM commits c JOIN commit_files cf ON cf.commit_entity_id = c.entity_id
      WHERE c.project_id = $1 AND c.is_fix AND cf.path = ANY($2)
      ORDER BY c.authored_at DESC
      LIMIT 5`,
    [project.id, list]
  );

  return { paths: list, rules, memories, recent_fixes: fixes.rows };
}
