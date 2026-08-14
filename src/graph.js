import { pool, toVector, getProject } from "./db.js";
import { embedQuery, embeddingsEnabled } from "./embeddings.js";
import { fuseRankedLists, DEFAULT_K } from "./rrf.js";
import { BODY_TRUNCATION_MARKER } from "./parser.js";

const SYMBOL_COLUMNS = "s.id, s.name, s.kind, s.signature, s.doc, s.start_line, s.end_line, f.path";

async function requireProject(name) {
  const p = await getProject(name);
  if (!p) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return p;
}

/**
 * Confirm a symbol name resolves before answering a question about it.
 *
 * `get_callers` on a name that doesn't exist used to return `[]`, which is
 * indistinguishable from "nothing calls this" -- the difference between "safe to
 * change" and "you typed the name wrong". That matters most for the agent
 * consumers, which will happily act on an empty answer.
 *
 * The match here is deliberately the same rule every query below uses (exact
 * name, or a `Class::method` suffix), so a name that would have been found is
 * never rejected by the check.
 */
async function requireSymbol(project, name) {
  const res = await pool.query(
    `SELECT 1 FROM symbols
      WHERE project_id = $1 AND (name = $2 OR name LIKE '%::' || $2) LIMIT 1`,
    [project.id, name]
  );
  if (!res.rows.length) {
    throw new Error(
      `No symbol named "${name}" in project "${project.name}". ` +
      `Pass an exact name or Class::method — search_code finds one from a description.`
    );
  }
}

/** Same reasoning as requireSymbol, for the path-addressed queries. */
async function requireFile(project, filePath) {
  const res = await pool.query(
    `SELECT 1 FROM files WHERE project_id = $1 AND path = $2 LIMIT 1`,
    [project.id, filePath]
  );
  if (!res.rows.length) {
    throw new Error(
      `No indexed file at "${filePath}" in project "${project.name}". ` +
      `Pass a path relative to the project root, e.g. src/indexer.js.`
    );
  }
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
    const qv = await embedQuery(query, project.id);
    vectorRows = await vectorCandidates(project.id, qv, poolSize);
    rankedLists.vector = vectorRows.map((r) => r.id);
  }

  const byId = new Map();
  for (const row of [...ftsRows, ...vectorRows]) byId.set(row.id, row);

  const fused = fuseRankedLists(rankedLists, DEFAULT_K);
  return fused.slice(0, limit).map(({ id, score, sources }) => {
    // s.id only exists to key byId/rankedLists during fusion -- the caller
    // addresses symbols by name, not by internal row id, so drop it here.
    const { id: _id, ...row } = byId.get(id);
    return { ...row, score, matched_via: sources };
  });
}

const CHUNK_COLUMNS = `
  c.id, c.heading_path, c.content, e.kind AS entity_kind,
  d.path, COALESCE(d.title, e.title) AS title, d.doc_type`;

// Joined on entities, not documents: every chunk-bearing kind belongs in this
// ranking -- documents from Phase 2, memories from Phase 3 -- and a LEFT JOIN
// keeps the document columns available without excluding the kinds that have no
// document row.
const CHUNK_SOURCE = `
  chunks c
  JOIN entities e ON e.id = c.entity_id AND e.deleted_at IS NULL
  LEFT JOIN documents d ON d.entity_id = c.entity_id`;

async function chunkFtsCandidates(projectId, query, poolSize) {
  const res = await pool.query(
    `SELECT ${CHUNK_COLUMNS}
     FROM ${CHUNK_SOURCE}
     WHERE c.project_id = $1 AND c.fts_vector @@ plainto_tsquery('simple', $2)
     ORDER BY ts_rank(c.fts_vector, plainto_tsquery('simple', $2)) DESC
     LIMIT $3`,
    [projectId, query, poolSize]
  );
  return res.rows;
}

async function chunkVectorCandidates(projectId, queryVector, poolSize) {
  const res = await pool.query(
    `SELECT ${CHUNK_COLUMNS}
     FROM ${CHUNK_SOURCE}
     WHERE c.project_id = $1 AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $2
     LIMIT $3`,
    [projectId, toVector(queryVector), poolSize]
  );
  return res.rows;
}

/**
 * Hybrid search over code AND prose in one ranking.
 *
 * Four ranked lists -- symbol full-text, symbol vector, chunk full-text, chunk
 * vector -- go through the same RRF as searchCode. Ids are namespaced
 * ("sym:123", "chunk:456") because fuseRankedLists keys on opaque ids, so
 * fusing two tables needs no change to src/rrf.js at all. With embeddings off
 * only the two full-text lists exist, degrading the way symbol search already
 * does.
 *
 * searchCode is deliberately left alone: it is the operation agents reach for
 * by default and its quality is measured by eval/recall.js against real
 * commits, so mixing prose into it would move a number that has to stay
 * comparable across phases.
 */
export async function searchKnowledge(projectName, query, limit = 10) {
  const project = await requireProject(projectName);
  const poolSize = Math.max(limit * 5, 50);

  const [symFts, chunkFts] = await Promise.all([
    ftsCandidates(project.id, query, poolSize),
    chunkFtsCandidates(project.id, query, poolSize),
  ]);
  const rankedLists = {
    symbol_fts: symFts.map((r) => `sym:${r.id}`),
    chunk_fts: chunkFts.map((r) => `chunk:${r.id}`),
  };

  let symVec = [];
  let chunkVec = [];
  if (embeddingsEnabled()) {
    const qv = await embedQuery(query, project.id);
    [symVec, chunkVec] = await Promise.all([
      vectorCandidates(project.id, qv, poolSize),
      chunkVectorCandidates(project.id, qv, poolSize),
    ]);
    rankedLists.symbol_vector = symVec.map((r) => `sym:${r.id}`);
    rankedLists.chunk_vector = chunkVec.map((r) => `chunk:${r.id}`);
  }

  const byId = new Map();
  for (const r of [...symFts, ...symVec]) {
    byId.set(`sym:${r.id}`, {
      type: "code",
      path: r.path,
      title: r.name,
      heading_path: null,
      snippet: r.signature || r.doc || null,
      kind: r.kind,
      start_line: r.start_line,
      end_line: r.end_line,
    });
  }
  for (const r of [...chunkFts, ...chunkVec]) {
    byId.set(`chunk:${r.id}`, {
      // 'document' reads as 'doc' for symmetry with 'code'; any other
      // chunk-bearing kind (today: memory) is reported as itself.
      type: r.entity_kind === "document" ? "doc" : r.entity_kind,
      path: r.path,
      title: r.title,
      heading_path: r.heading_path,
      snippet: r.content.slice(0, 600),
      doc_type: r.doc_type,
    });
  }

  return fuseRankedLists(rankedLists, DEFAULT_K)
    .slice(0, limit)
    .map(({ id, score, sources }) => ({ ...byId.get(id), score, matched_via: sources }));
}

export async function getSymbol(projectName, name, limit = 5) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND (s.name = $2 OR s.name LIKE '%::' || $2)
     ORDER BY s.name = $2 DESC LIMIT $3`,
    [project.id, name, limit]
  );
  // No requireSymbol call: this query IS the existence check, so a second one
  // would only duplicate the round trip.
  if (!res.rows.length) {
    throw new Error(
      `No symbol named "${name}" in project "${project.name}". ` +
      `Pass an exact name or Class::method — search_code finds one from a description.`
    );
  }
  // A bare name (e.g. "type") can match hundreds of unrelated symbols across
  // classes. Only the best-ranked candidate is worth its full source body;
  // the rest come back as stubs so an ambiguous name doesn't pull N full
  // bodies. Re-query with the qualified "Class::method" name to get another
  // candidate's body. embedding/fts_vector/body_fingerprint/entity_id/
  // symbol_key/id/project_id/file_id are internal bookkeeping, never useful
  // to the caller — drop them all.
  return res.rows.map(
    ({ name, kind, signature, doc, start_line, end_line, path, body }, i) => ({
      name,
      kind,
      signature,
      doc,
      start_line,
      end_line,
      path,
      // Truncation at index time (parser.js MAX_BODY) leaves a dead-end
      // marker with no way back to the rest of the function, which pushes
      // the caller into blind-grepping the file. Point at the exact lines
      // instead — start_line/end_line above are the untruncated symbol's
      // real range, so Read(path, offset=start_line) gets the rest directly.
      ...(i === 0
        ? {
            body: body?.endsWith(BODY_TRUNCATION_MARKER)
              ? body.slice(0, -BODY_TRUNCATION_MARKER.length) +
                `\n/* …truncated — full body is ${path}:${start_line}-${end_line}, read that range directly */`
              : body,
          }
        : {}),
    })
  );
}

export async function getCallers(projectName, name, limit = 10) {
  const project = await requireProject(projectName);
  await requireSymbol(project, name);
  const res = await pool.query(
    `SELECT DISTINCT src_s.name AS caller, src_s.kind, f.path, e.relation, e.line
     FROM edges e
     JOIN symbols dst_s ON dst_s.id = e.dst
     LEFT JOIN symbols src_s ON src_s.id = e.src
     LEFT JOIN files f ON f.id = e.file_id
     WHERE e.project_id = $1
       AND (dst_s.name = $2 OR dst_s.name LIKE '%::' || $2)
     ORDER BY caller NULLS LAST
     LIMIT $3`,
    [project.id, name, limit]
  );
  return res.rows;
}

export async function getCallees(projectName, name, limit = 10) {
  const project = await requireProject(projectName);
  await requireSymbol(project, name);
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
     ORDER BY e.relation, target
     LIMIT $3`,
    [project.id, name, limit]
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
  if (!seed.rows.length) {
    throw new Error(
      `No symbol named "${name}" in project "${project.name}". ` +
      `Pass an exact name or Class::method — search_code finds one from a description.`
    );
  }

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
  // `id` on each node is only the BFS visited-set key (see nodes.has(id)
  // above); edges already address nodes by name, so it never reaches the
  // caller.
  return {
    root: seed.rows[0].name,
    nodes: [...nodes.values()].map(({ name, kind }) => ({ name, kind })),
    edges: uniqEdges,
  };
}

export async function getFileOutline(projectName, filePath, limit = 10) {
  const project = await requireProject(projectName);
  await requireFile(project, filePath);
  const res = await pool.query(
    `SELECT s.name, s.kind, s.signature, s.doc, s.start_line, s.end_line
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.project_id = $1 AND f.path = $2
     ORDER BY s.start_line
     LIMIT $3`,
    [project.id, filePath, limit]
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
  // An empty result here is legitimate and documented -- it's what you get with
  // embeddings disabled -- which is exactly why a misspelled name must not
  // produce the same answer.
  await requireSymbol(project, name);
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
