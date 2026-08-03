/**
 * Give symbols indexed before the identity plane existed their keys and
 * entities, without reparsing anything.
 *
 * Why this is a command and not part of migration 0006: `symbols` carries a
 * vector(1024) column, a STORED generated tsvector and a multi-gigabyte HNSW
 * index. Every UPDATE is a non-HOT update, so each one rewrites the heap tuple
 * (including the 4 KB vector), recomputes the tsvector over the whole body and
 * re-inserts into the HNSW graph. On a 5.1 GB / 326k-symbol database that came
 * to over 12 minutes -- inside applyMigrations(), which runs on MCP server
 * startup. A migration is the wrong place for a job that can't be interrupted
 * and can't report progress.
 *
 * So: batched by file, resumable (it only ever looks at rows still missing a
 * key), and safe to run while nothing else is indexing that project.
 *
 * The key numbering here must agree with assignSymbolKeys() in src/identity.js
 * -- the same symbol has to get the same key whether it arrived through the
 * indexer or through this backfill. test/identity.backfill.test.js asserts it.
 */
import { pool } from "./db.js";

/** Files per batch. Each batch is one transaction. */
const DEFAULT_BATCH_FILES = 200;

/** How much is left to do, per project. */
export async function identityBackfillStatus(projectId = null) {
  const res = await pool.query(
    `SELECT p.id, p.name,
            count(*) FILTER (WHERE s.symbol_key IS NULL)::int AS unkeyed,
            count(*) FILTER (WHERE s.entity_id IS NULL)::int  AS unlinked,
            count(*)::int AS symbols
       FROM projects p
       JOIN symbols s ON s.project_id = p.id
      WHERE ($1::int IS NULL OR p.id = $1)
      GROUP BY p.id, p.name
      ORDER BY p.name`,
    [projectId]
  );
  return res.rows;
}

/**
 * Backfill one project.
 *
 * @param {{id:number, org_id:number, name:string}} project
 * @param {object} [opts]
 * @param {number} [opts.batchFiles] files per transaction
 * @param {(msg:string)=>void} [opts.log]
 */
export async function backfillProjectIdentity(project, { batchFiles = DEFAULT_BATCH_FILES, log = () => {} } = {}) {
  // Work file by file rather than symbol by symbol: the ~n duplicate suffix is
  // scoped to a file, so a batch has to contain whole files or two runs could
  // number the same duplicates differently.
  const pending = await pool.query(
    `SELECT DISTINCT s.file_id FROM symbols s
      WHERE s.project_id = $1 AND (s.symbol_key IS NULL OR s.entity_id IS NULL)
      ORDER BY s.file_id`,
    [project.id]
  );
  const fileIds = pending.rows.map((r) => r.file_id);
  if (!fileIds.length) return { files: 0, symbols: 0, entities: 0 };

  let symbols = 0;
  let entities = 0;
  for (let i = 0; i < fileIds.length; i += batchFiles) {
    const slice = fileIds.slice(i, i + batchFiles);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // One UPDATE for both columns: each extra pass over these rows costs a
      // full heap rewrite plus HNSW maintenance, so they are worth combining
      // even though the SQL is uglier for it.
      const keyed = await client.query(
        `WITH numbered AS (
           SELECT s.id, f.path,
                  row_number() OVER (
                    PARTITION BY s.file_id, s.kind, s.name
                    ORDER BY s.start_line, s.id
                  ) AS dup,
                  btrim(regexp_replace(coalesce(s.body, ''), '\\s+', ' ', 'g')) AS norm_body
             FROM symbols s
             JOIN files f ON f.id = s.file_id
            WHERE s.file_id = ANY($1) AND s.symbol_key IS NULL
         )
         UPDATE symbols s
            SET symbol_key = n.path || '#' || s.kind || ':' || s.name
                             || CASE WHEN n.dup > 1 THEN '~' || n.dup ELSE '' END,
                -- Same normalisation and 64-char floor as bodyFingerprint().
                body_fingerprint = CASE
                  WHEN length(n.norm_body) >= 64
                  THEN encode(sha256(convert_to(n.norm_body, 'UTF8')), 'hex')
                  ELSE NULL END
           FROM numbered n
          WHERE s.id = n.id`,
        [slice]
      );

      const made = await client.query(
        `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
         SELECT $2, $3, 'symbol', s.symbol_key, s.name, 'parsed',
                jsonb_build_object('kind', s.kind, 'path', f.path, 'fingerprint', s.body_fingerprint)
           FROM symbols s
           JOIN files f ON f.id = s.file_id
          WHERE s.file_id = ANY($1) AND s.symbol_key IS NOT NULL AND s.entity_id IS NULL
         ON CONFLICT (project_id, kind, natural_key) DO UPDATE
            SET data = entities.data || EXCLUDED.data, updated_at = now()`,
        [slice, project.org_id, project.id]
      );

      await client.query(
        `UPDATE symbols s SET entity_id = e.id
           FROM entities e
          WHERE s.file_id = ANY($1) AND s.entity_id IS NULL
            AND e.project_id = $2 AND e.kind = 'symbol'
            AND e.natural_key = s.symbol_key`,
        [slice, project.id]
      );

      await client.query("COMMIT");
      symbols += keyed.rowCount;
      entities += made.rowCount;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw new Error(`Backfill failed on ${project.name} (files ${i}-${i + slice.length}): ${e.message}`);
    }
    client.release();

    const done = Math.min(i + batchFiles, fileIds.length);
    log(`${project.name}: ${done}/${fileIds.length} files, ${symbols} symbols keyed`);
  }

  return { files: fileIds.length, symbols, entities };
}
