/**
 * Engineering memory: what this project has learned, so it survives the session
 * that learned it.
 *
 * Agent-writable, unlike rules. A memory is an observation ("the gateway
 * rejects duplicate charges") rather than a prescription, so the cost of a wrong
 * one is a bad search result rather than an agent confidently following
 * something nobody ever said.
 *
 * The text is stored in `chunks` instead of getting its own embedding column,
 * which means memories inherit the HNSW index, the generated fts_vector, the
 * embed-on-NULL healing pass and the embeddings-off degradation already built
 * for documents in Phase 2.
 */
import crypto from "node:crypto";
import { pool, getProject, toVector } from "../db.js";
import { config } from "../config.js";
import { embedQuery, embeddingsEnabled } from "../embeddings.js";
import { fuseRankedLists, DEFAULT_K } from "../rrf.js";
import { chunkMarkdown } from "./chunker.js";

const MEMORY_COLUMNS = `
  m.entity_id AS id, e.natural_key AS key, m.kind, m.content, m.scope,
  m.source, m.author, m.pinned, m.created_at`;

// A memory that has been corrected stays in the table -- it is a record of what
// someone believed, and why -- but must not be recalled, or the agent gets both
// answers and no way to choose between them.
const NOT_SUPERSEDED = `
  NOT EXISTS (SELECT 1 FROM memories s WHERE s.supersedes = m.entity_id)`;

async function requireProject(name) {
  const project = await getProject(name);
  if (!project) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return project;
}

export function memoryKey(content, scope) {
  const hash = crypto
    .createHash("sha256")
    .update(`${content.trim().replace(/\s+/g, " ").toLowerCase()}|${scope ?? ""}`)
    .digest("hex");
  return `mem:${hash.slice(0, 12)}`;
}

/**
 * Record something learned about this project.
 *
 * @param {string} projectName
 * @param {{content:string, kind?:string, scope?:string|null, supersedes?:string,
 *          pinned?:boolean, author?:string|null, source?:string}} opts
 */
export async function remember(projectName, opts) {
  const project = await requireProject(projectName);
  const content = String(opts.content ?? "").trim();
  if (!content) throw new Error("A memory needs content");

  const kind = opts.kind ?? "gotcha";
  const scope = opts.scope ?? null;
  const key = memoryKey(content, scope);
  const chunks = chunkMarkdown(content, { target: config.docsChunkChars });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let supersedesId = null;
    if (opts.supersedes) {
      const prev = await client.query(
        `SELECT id FROM entities
          WHERE project_id = $1 AND kind = 'memory'
            AND (natural_key = $2 OR id::text = $2)`,
        [project.id, String(opts.supersedes)]
      );
      if (!prev.rows.length) throw new Error(`No memory "${opts.supersedes}" to supersede`);
      supersedesId = prev.rows[0].id;
    }

    const er = await client.query(
      `INSERT INTO entities (org_id, project_id, kind, natural_key, title, summary,
                             source, occurred_at, data)
       VALUES ($1,$2,'memory',$3,$4,$5,$6, now(), $7)
       ON CONFLICT (project_id, kind, natural_key) DO UPDATE
          SET summary = EXCLUDED.summary, data = entities.data || EXCLUDED.data,
              deleted_at = NULL, updated_at = now()
       RETURNING id`,
      [
        project.org_id, project.id, key, content.slice(0, 120), content.slice(0, 400),
        opts.source ?? "agent", JSON.stringify({ kind, scope }),
      ]
    );
    const entityId = er.rows[0].id;

    await client.query(
      `INSERT INTO memories (entity_id, org_id, project_id, kind, content, scope,
                             source, author, supersedes, pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (entity_id) DO UPDATE
          SET kind = EXCLUDED.kind, content = EXCLUDED.content, scope = EXCLUDED.scope,
              supersedes = COALESCE(EXCLUDED.supersedes, memories.supersedes),
              pinned = EXCLUDED.pinned, updated_at = now()`,
      [
        entityId, project.org_id, project.id, kind, content, scope,
        opts.source ?? "agent", opts.author ?? null, supersedesId, Boolean(opts.pinned),
      ]
    );

    await client.query(
      `INSERT INTO chunks (org_id, project_id, entity_id, ord, heading_path, content,
                           content_hash, token_estimate)
       SELECT $1, $2, $3, u.ord, u.hp, u.content, u.hash, u.tok
         FROM unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::int[])
              AS u(ord, hp, content, hash, tok)
       ON CONFLICT (entity_id, ord) DO UPDATE
          SET heading_path = EXCLUDED.heading_path, content = EXCLUDED.content,
              content_hash = EXCLUDED.content_hash, token_estimate = EXCLUDED.token_estimate,
              embedding = CASE WHEN chunks.content_hash = EXCLUDED.content_hash
                               THEN chunks.embedding ELSE NULL END`,
      [
        project.org_id, project.id, entityId,
        chunks.map((c) => c.ord),
        chunks.map(() => `memory:${kind}`),
        chunks.map((c) => c.content),
        chunks.map((c) => c.contentHash),
        chunks.map((c) => c.tokenEstimate),
      ]
    );
    await client.query(`DELETE FROM chunks WHERE entity_id = $1 AND ord >= $2`, [
      entityId, chunks.length,
    ]);

    await client.query("COMMIT");
    return { id: entityId, key, kind, chunks: chunks.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Retrieve memories relevant to a question.
 *
 * Pinned memories come first unconditionally -- somebody pinned them because
 * they always matter -- then hybrid-ranked matches fill the rest of the budget.
 */
export async function recall(projectName, query, limit = 10) {
  const project = await requireProject(projectName);
  const poolSize = Math.max(limit * 5, 50);

  const pinned = await pool.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories m JOIN entities e ON e.id = m.entity_id
      WHERE m.project_id = $1 AND m.pinned AND e.deleted_at IS NULL AND ${NOT_SUPERSEDED}
      ORDER BY m.updated_at DESC`,
    [project.id]
  );

  const fts = await pool.query(
    `SELECT ${MEMORY_COLUMNS}
       FROM chunks c
       JOIN memories m ON m.entity_id = c.entity_id
       JOIN entities e ON e.id = m.entity_id
      WHERE c.project_id = $1 AND e.deleted_at IS NULL AND ${NOT_SUPERSEDED}
        AND c.fts_vector @@ plainto_tsquery('simple', $2)
      ORDER BY ts_rank(c.fts_vector, plainto_tsquery('simple', $2)) DESC
      LIMIT $3`,
    [project.id, query, poolSize]
  );
  const rankedLists = { fts: fts.rows.map((r) => r.id) };

  let vec = { rows: [] };
  if (embeddingsEnabled()) {
    const qv = await embedQuery(query, project.id);
    vec = await pool.query(
      `SELECT ${MEMORY_COLUMNS}
         FROM chunks c
         JOIN memories m ON m.entity_id = c.entity_id
         JOIN entities e ON e.id = m.entity_id
        WHERE c.project_id = $1 AND c.embedding IS NOT NULL
          AND e.deleted_at IS NULL AND ${NOT_SUPERSEDED}
        ORDER BY c.embedding <=> $2
        LIMIT $3`,
      [project.id, toVector(qv), poolSize]
    );
    rankedLists.vector = vec.rows.map((r) => r.id);
  }

  const byId = new Map();
  for (const r of [...fts.rows, ...vec.rows]) byId.set(r.id, r);

  const ranked = fuseRankedLists(rankedLists, DEFAULT_K)
    .map(({ id, score, sources }) => ({ ...byId.get(id), score, matched_via: sources }))
    .filter((m) => m.id);

  const pinnedIds = new Set(pinned.rows.map((r) => r.id));
  return [
    ...pinned.rows.map((m) => ({ ...m, score: null, matched_via: ["pinned"] })),
    ...ranked.filter((m) => !pinnedIds.has(m.id)),
  ].slice(0, limit);
}
