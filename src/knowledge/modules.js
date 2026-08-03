/**
 * Modules: the unit every derived metric is aggregated over.
 *
 * A module is a directory at a fixed depth. That is a deliberately boring
 * choice -- see 0009_derived_intelligence.sql for why it beats graph community
 * detection -- and it buys three things: a module has a name people already use
 * ("the knowledge layer"), the same module is recognisable between runs so last
 * week's churn is comparable to this week's, and assigning a file to a module is
 * a string operation rather than a graph partition.
 */
import { pool } from "../db.js";
import { config } from "../config.js";

/**
 * The module a file belongs to.
 *
 * Files at the repo root have no directory to name, and they are usually the
 * ones that matter most (package.json, README.md), so they get their own "."
 * module rather than being dropped.
 *
 * @param {string} filePath repo-relative, forward slashes
 * @param {number} depth how many directory levels a module name may span
 * @returns {string} "src/knowledge", "src", or "."
 */
export function modulePathFor(filePath, depth = config.moduleDepth) {
  const parts = filePath.split("/");
  parts.pop(); // the filename itself is never part of the module path
  if (!parts.length) return ".";
  return parts.slice(0, Math.max(1, depth)).join("/");
}

/** Short display name: the last segment, or "(root)" for the "." module. */
export function moduleNameFor(modulePath) {
  if (modulePath === ".") return "(root)";
  const parts = modulePath.split("/");
  return parts[parts.length - 1];
}

/** How many directory levels this module path spans. "." is depth 0. */
export function moduleDepthOf(modulePath) {
  return modulePath === "." ? 0 : modulePath.split("/").length;
}

/**
 * Group files into modules. Pure, so the grouping rule is testable without a
 * database and without an indexed repo.
 *
 * @param {Array<{id:number, path:string, loc:number, symbols:number}>} files
 * @param {number} depth
 * @returns {Array<{path:string, name:string, depth:number, fileIds:number[],
 *                  fileCount:number, loc:number, symbolCount:number}>}
 *          sorted by path, so the write order (and any log output) is stable
 */
export function groupFilesIntoModules(files, depth = config.moduleDepth) {
  const byPath = new Map();
  for (const f of files) {
    const modPath = modulePathFor(f.path, depth);
    let mod = byPath.get(modPath);
    if (!mod) {
      mod = {
        path: modPath, name: moduleNameFor(modPath), depth: moduleDepthOf(modPath),
        fileIds: [], fileCount: 0, loc: 0, symbolCount: 0,
      };
      byPath.set(modPath, mod);
    }
    mod.fileIds.push(f.id);
    mod.fileCount++;
    mod.loc += f.loc ?? 0;
    mod.symbolCount += f.symbols ?? 0;
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Recompute `modules`, `module_members` and `module_deps` for a project.
 *
 * Module rows are upserted by (project_id, path) rather than deleted and
 * reinserted, so ids survive a recompute. That matters twice over: metrics,
 * ownership and clusters hang off module_id and are computed under their own
 * watermarks, so wiping module ids here would cascade away derived data that
 * this run may not be about to recompute; and the web UI links to modules by id.
 *
 * @returns {Promise<{modules:number, members:number, deps:number, pruned:number}>}
 */
export async function writeModules(project, log = () => {}) {
  const files = await pool.query(
    `SELECT f.id, f.path, COALESCE(f.loc, 0) AS loc,
            (SELECT count(*) FROM symbols s WHERE s.file_id = f.id) AS symbols
       FROM files f WHERE f.project_id = $1`,
    [project.id]
  );
  const grouped = groupFilesIntoModules(
    files.rows.map((r) => ({ ...r, loc: Number(r.loc), symbols: Number(r.symbols) })),
    config.moduleDepth
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ids = new Map(); // module path -> id
    for (const m of grouped) {
      const res = await client.query(
        `INSERT INTO modules (org_id, project_id, path, name, depth, file_count, loc, symbol_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, path) DO UPDATE
            SET name = EXCLUDED.name, depth = EXCLUDED.depth,
                file_count = EXCLUDED.file_count, loc = EXCLUDED.loc,
                symbol_count = EXCLUDED.symbol_count
         RETURNING id`,
        [project.org_id, project.id, m.path, m.name, m.depth, m.fileCount, m.loc, m.symbolCount]
      );
      ids.set(m.path, res.rows[0].id);
    }

    // A module whose last file was deleted goes away, and its metrics and
    // ownership go with it by cascade -- which is right: there is nothing left
    // to own.
    const pruned = await client.query(
      `DELETE FROM modules WHERE project_id = $1 AND NOT (path = ANY($2::text[]))`,
      [project.id, grouped.map((m) => m.path)]
    );

    await client.query(
      `DELETE FROM module_members WHERE module_id IN (SELECT id FROM modules WHERE project_id = $1)`,
      [project.id]
    );
    let members = 0;
    for (const m of grouped) {
      const res = await client.query(
        `INSERT INTO module_members (module_id, file_id)
         SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`,
        [ids.get(m.path), m.fileIds]
      );
      members += res.rowCount;
    }

    // Lifted entirely in SQL: `edges` is the biggest table in the database and
    // there is no reason to move it through Node to count it. Unresolved edges
    // (dst_name with no dst symbol) drop out of the join, which is correct --
    // an unresolved call names no module.
    await client.query(`DELETE FROM module_deps WHERE project_id = $1`, [project.id]);
    const deps = await client.query(
      `INSERT INTO module_deps (project_id, src_module_id, dst_module_id, edge_count)
       SELECT $1, sm.module_id, dm.module_id, count(*)
         FROM edges e
         JOIN symbols ss ON ss.id = e.src
         JOIN symbols ds ON ds.id = e.dst
         JOIN module_members sm ON sm.file_id = ss.file_id
         JOIN module_members dm ON dm.file_id = ds.file_id
        WHERE e.project_id = $1 AND sm.module_id <> dm.module_id
        GROUP BY 1, 2, 3`,
      [project.id]
    );

    await client.query("COMMIT");
    if (pruned.rowCount) log(`Modules: pruned ${pruned.rowCount} empty module(s)`);
    return {
      modules: grouped.length, members, deps: deps.rowCount, pruned: pruned.rowCount,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
