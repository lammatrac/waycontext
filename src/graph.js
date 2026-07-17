import { pool, toVector, getProject } from "./db.js";
import { embedQuery, embeddingsEnabled } from "./embeddings.js";
import { fuseRankedLists } from "./rrf.js";

const RRF_K = 60;
const SYMBOL_COLUMNS = "s.id, s.name, s.kind, s.signature, s.doc, s.start_line, s.end_line, f.path";

async function requireProject(name) {
  const p = await getProject(name);
  if (!p) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return p;
}

async function ftsCandidates(projectId, query, poolSize) {
  const res = await pool.query(
    `SELECT ${SYMBOL_COLUMNS}
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND s.fts_vector @@ plainto_tsquery('simple', $2)
     ORDER BY ts_rank(s.fts_vector, plainto_tsquery('simple', $2)) DESC
     LIMIT $3`,
    [projectId, query, poolSize]
  );
  return res.rows;
}

async function vectorCandidates(projectId, queryVector, poolSize) {
  const res = await pool.query(
    `SELECT ${SYMBOL_COLUMNS}
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND s.embedding IS NOT NULL
     ORDER BY s.embedding <=> $2
     LIMIT $3`,
    [projectId, toVector(queryVector), poolSize]
  );
  return res.rows;
}

/**
 * Hybrid search over symbols: fuses Postgres full-text ranking with pgvector
 * ANN similarity (when embeddings are enabled) via Reciprocal Rank Fusion.
 * Falls back to full-text only when embeddings are disabled.
 */
export async function searchCode(projectName, query, limit = 10) {
  const project = await requireProject(projectName);
  const poolSize = Math.max(limit * 5, 50);

  const ftsRows = await ftsCandidates(project.id, query, poolSize);
  const rankedLists = { fts: ftsRows.map((r) => r.id) };

  let vectorRows = [];
  if (embeddingsEnabled()) {
    const qv = await embedQuery(query);
    vectorRows = await vectorCandidates(project.id, qv, poolSize);
    rankedLists.vector = vectorRows.map((r) => r.id);
  }

  const byId = new Map();
  for (const row of [...ftsRows, ...vectorRows]) byId.set(row.id, row);

  const fused = fuseRankedLists(rankedLists, RRF_K);
  return fused.slice(0, limit).map(({ id, score, sources }) => ({
    ...byId.get(id),
    score,
    matched_via: sources,
  }));
}

export async function getSymbol(projectName, name) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND (s.name = $2 OR s.name LIKE '%::' || $2)
     ORDER BY s.name = $2 DESC LIMIT 5`,
    [project.id, name]
  );
  return res.rows.map(({ embedding, ...r }) => r);
}

export async function getCallers(projectName, name) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT DISTINCT src_s.name AS caller, src_s.kind, f.path, e.relation, e.line
     FROM edges e
     JOIN symbols dst_s ON dst_s.id = e.dst
     LEFT JOIN symbols src_s ON src_s.id = e.src
     LEFT JOIN files f ON f.id = e.file_id
     WHERE e.project_id = $1
       AND (dst_s.name = $2 OR dst_s.name LIKE '%::' || $2)
     ORDER BY caller NULLS LAST`,
    [project.id, name]
  );
  return res.rows;
}

export async function getCallees(projectName, name) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT DISTINCT e.relation,
            COALESCE(dst_s.name, e.dst_name) AS target,
            dst_s.kind, f2.path AS target_file, e.line
     FROM edges e
     JOIN symbols src_s ON src_s.id = e.src
     LEFT JOIN symbols dst_s ON dst_s.id = e.dst
     LEFT JOIN files f2 ON f2.id = dst_s.file_id
     WHERE e.project_id = $1
       AND (src_s.name = $2 OR src_s.name LIKE '%::' || $2)
     ORDER BY e.relation, target`,
    [project.id, name]
  );
  return res.rows;
}

/** BFS subgraph around a symbol, up to `depth` hops (both directions). */
export async function getSubgraph(projectName, name, depth = 2, maxNodes = 60) {
  const project = await requireProject(projectName);
  const seed = await pool.query(
    `SELECT id, name, kind FROM symbols
     WHERE project_id = $1 AND (name = $2 OR name LIKE '%::' || $2) LIMIT 1`,
    [project.id, name]
  );
  if (!seed.rows.length) throw new Error(`Symbol "${name}" not found`);

  const nodes = new Map([[seed.rows[0].id, seed.rows[0]]]);
  const edges = [];
  let frontier = [seed.rows[0].id];

  for (let d = 0; d < depth && frontier.length && nodes.size < maxNodes; d++) {
    const res = await pool.query(
      `SELECT e.relation, e.src, e.dst,
              s1.name AS src_name, s1.kind AS src_kind,
              s2.name AS dst_name_resolved, s2.kind AS dst_kind, e.dst_name
       FROM edges e
       LEFT JOIN symbols s1 ON s1.id = e.src
       LEFT JOIN symbols s2 ON s2.id = e.dst
       WHERE e.project_id = $1 AND (e.src = ANY($2) OR e.dst = ANY($2))`,
      [project.id, frontier]
    );
    const next = [];
    for (const r of res.rows) {
      edges.push({
        from: r.src_name || "@file",
        to: r.dst_name_resolved || r.dst_name,
        relation: r.relation,
      });
      for (const [id, nm, kd] of [
        [r.src, r.src_name, r.src_kind],
        [r.dst, r.dst_name_resolved, r.dst_kind],
      ]) {
        if (id && !nodes.has(id) && nodes.size < maxNodes) {
          nodes.set(id, { id, name: nm, kind: kd });
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  // dedupe edges
  const seen = new Set();
  const uniqEdges = edges.filter((e) => {
    const k = `${e.from}|${e.relation}|${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { root: seed.rows[0].name, nodes: [...nodes.values()], edges: uniqEdges };
}

export async function getFileOutline(projectName, filePath) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT s.name, s.kind, s.signature, s.doc, s.start_line, s.end_line
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND f.path = $2
     ORDER BY s.start_line`,
    [project.id, filePath]
  );
  return res.rows;
}

/** High-level project map: dirs, largest files, hook usage, most-connected symbols. */
export async function getProjectOverview(projectName) {
  const project = await requireProject(projectName);
  const [files, hubs, hooks, langs] = await Promise.all([
    pool.query(
      `SELECT split_part(path, '/', 1) AS top_dir, count(*) AS files, sum(loc) AS loc
       FROM files WHERE project_id = $1 GROUP BY 1 ORDER BY loc DESC NULLS LAST LIMIT 20`,
      [project.id]
    ),
    pool.query(
      `SELECT s.name, s.kind, f.path,
              (SELECT count(*) FROM edges e WHERE e.dst = s.id) AS inbound,
              (SELECT count(*) FROM edges e WHERE e.src = s.id) AS outbound
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.project_id = $1
       ORDER BY (SELECT count(*) FROM edges e WHERE e.dst = s.id) DESC
       LIMIT 15`,
      [project.id]
    ),
    pool.query(
      `SELECT replace(dst_name, 'hook:', '') AS hook, relation, count(*) AS uses
       FROM edges
       WHERE project_id = $1 AND relation IN ('REGISTERS_HOOK','FIRES_HOOK')
       GROUP BY 1, 2 ORDER BY uses DESC LIMIT 25`,
      [project.id]
    ),
    pool.query(
      `SELECT language, count(*) AS files, sum(loc) AS loc
       FROM files WHERE project_id = $1 GROUP BY 1 ORDER BY loc DESC`,
      [project.id]
    ),
  ]);
  return {
    project: { name: project.name, root: project.root_path, indexed_at: project.indexed_at },
    languages: langs.rows,
    top_directories: files.rows,
    most_referenced_symbols: hubs.rows,
    wordpress_hooks: hooks.rows,
  };
}

/** Symbols semantically similar to a given symbol (feature clustering helper). */
export async function findRelated(projectName, name, limit = 10) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT s2.name, s2.kind, f.path, 1 - (s2.embedding <=> s1.embedding) AS score
     FROM symbols s1
     JOIN symbols s2 ON s2.project_id = s1.project_id AND s2.id <> s1.id
     JOIN files f ON f.id = s2.file_id
     WHERE s1.project_id = $1
       AND (s1.name = $2 OR s1.name LIKE '%::' || $2)
       AND s1.embedding IS NOT NULL AND s2.embedding IS NOT NULL
     ORDER BY s2.embedding <=> s1.embedding
     LIMIT $3`,
    [project.id, name, limit]
  );
  return res.rows;
}
