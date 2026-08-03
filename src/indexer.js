import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import picomatch from "picomatch";
import { pool, toVector, getOrCreateProject } from "./db.js";
import { parseFile, EXT_LANG } from "./parser.js";
import { embed, embeddingsEnabled } from "./embeddings.js";
import { config } from "./config.js";
import { getChangedFiles, getHeadSha } from "./gitDiff.js";
import { assignSymbolKeys, matchRenames } from "./identity.js";
import { ingestGitHistory } from "./knowledge/gitHistory.js";
import { parseDocument } from "./knowledge/docs.js";
import { proposeRules } from "./knowledge/rules.js";
import { importKnowledge } from "./knowledge/knowledgeFiles.js";

const DEFAULT_IGNORES = [
  "node_modules/**", "vendor/**", ".git/**", "dist/**", "build/**",
  "*.min.js", "*.min.css", "coverage/**", ".next/**", "__pycache__/**",
];

function loadGitignore(root) {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES.map((p) => p.replace("/**", "")));
  const gi = path.join(root, ".gitignore");
  if (fs.existsSync(gi)) ig.add(fs.readFileSync(gi, "utf8"));
  return ig;
}

// DEFAULT_IGNORES only prunes a fixed set of dirs during the glob walk;
// .gitignore entries were previously applied only as a post-filter, so a
// large ignored directory (e.g. a WordPress uploads folder) still got
// walked in full. Fold plain (non-negated) .gitignore entries into the
// glob-time ignore list too, so traversal actually skips them.
function loadGlobIgnores(root) {
  const patterns = [...DEFAULT_IGNORES];
  const gi = path.join(root, ".gitignore");
  if (fs.existsSync(gi)) {
    const lines = fs.readFileSync(gi, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
    for (const line of lines) {
      const clean = line.replace(/^\/+/, "").replace(/\/+$/, "");
      patterns.push(clean, `${clean}/**`);
    }
  }
  return patterns;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

let docMatcher = null;
let docMatcherGlobs = null;

/**
 * Is this path a document, per config.docsGlobs? The compiled matcher is cached
 * and rebuilt only when the glob list itself changes, since this runs once per
 * candidate path on a full scan of a large repo.
 */
function isDocPath(rel) {
  if (!config.docsEnabled) return false;
  if (docMatcherGlobs !== config.docsGlobs) {
    docMatcher = picomatch(config.docsGlobs, { dot: false });
    docMatcherGlobs = config.docsGlobs;
  }
  return docMatcher(rel);
}

/**
 * Index (or incrementally re-index) a project directory.
 * @param {string} projectName
 * @param {string} rootPath absolute path
 * @param {(msg:string)=>void} log
 */
export async function indexProject(projectName, rootPath, log = () => {}) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) throw new Error(`Path not found: ${root}`);

  const project = await getOrCreateProject(projectName, root);

  // Two overlapping indexProject runs on the SAME project (e.g. a commit-hook
  // reindex racing a pull-hook reindex from another session) mutate the same
  // files/symbols/edges rows concurrently: each file's DELETE+INSERT of
  // symbols reassigns fresh ids while the other run's edge-resolution still
  // references the old ones, which Postgres reports as either a deadlock
  // (40P01) or a dst/src foreign-key violation (23503) depending on timing.
  // A session-level advisory lock keyed by project id serializes runs for
  // that project while leaving other projects free to index in parallel.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [project.id]);
  try {
    return await runIndex(project, root, log);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [project.id]);
    lockClient.release();
  }
}

async function runIndex(project, root, log) {
  const ig = loadGitignore(root);

  const diffResult = await getChangedFiles(root, project.last_indexed_sha);
  let filePaths;
  let gitDeletedPaths = [];
  if (diffResult) {
    filePaths = diffResult.changed.filter(
      (p) => (EXT_LANG[path.extname(p)] || isDocPath(p)) && !ig.ignores(p)
    );
    gitDeletedPaths = diffResult.deleted;
    log(`Git diff since last index: ${filePaths.length} changed, ${gitDeletedPaths.length} deleted`);
  } else {
    const patterns = Object.keys(EXT_LANG).map((ext) => `**/*${ext}`);
    if (config.docsEnabled) patterns.push(...config.docsGlobs);
    const found = await fg(patterns, { cwd: root, dot: false, ignore: loadGlobIgnores(root) });
    filePaths = found.filter((p) => !ig.ignores(p));
    log(`Found ${filePaths.length} source files`);
  }

  // Existing hashes for incremental indexing
  const existing = new Map();
  const exRes = await pool.query(
    `SELECT id, path, hash FROM files WHERE project_id = $1`,
    [project.id]
  );
  for (const r of exRes.rows) existing.set(r.path, r);

  const seen = new Set();
  let changed = 0, skipped = 0, failed = 0;
  const pendingEmbeds = []; // { symbolId, text }

  // Identity bookkeeping for the whole run. Every symbol key that went away
  // and every key that turned up gets recorded here, and the two lists are
  // reconciled once at the end -- a rename can only be recognised by looking
  // at both sides, and the "new" side may live in a file processed much later
  // than the one the symbol left.
  const retired = [];  // { key, path, kind, name, fingerprint, entityId }
  const appeared = []; // { key, path, kind, name, fingerprint }
  const docStats = { documents: 0, chunks: 0, embedded: 0, mentions: 0 };

  for (const rel of filePaths) {
    seen.add(rel);
    const abs = path.join(root, rel);
    let content;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > config.maxFileSize) { skipped++; continue; }
      content = fs.readFileSync(abs, "utf8");
    } catch { failed++; continue; }

    const hash = sha256(content);
    const prev = existing.get(rel);
    if (prev && prev.hash === hash) { skipped++; continue; }

    // Docs branch away from parse->symbols->edges but keep everything above
    // this line: the same git-diff scoping, the same hash-skip, and below, the
    // same deleted-file handling. An extension that parses wins over the doc
    // globs, so a hypothetical `**/*.ts` in DOCS_GLOBS can't silently stop code
    // being parsed.
    if (!EXT_LANG[path.extname(rel)] && isDocPath(rel)) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const fileId = await upsertFileRow(client, project, prev, rel, "markdown", hash, content);
        const written = await writeDocument(client, project, fileId, rel, content, hash);
        await client.query("COMMIT");
        docStats.documents++;
        docStats.chunks += written.chunks;
        changed++;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        log(`DB error on ${rel}: ${e.message}`);
        failed++;
      } finally {
        client.release();
      }
      continue;
    }

    const lang = EXT_LANG[path.extname(rel)];
    let parsed;
    try {
      parsed = parseFile(lang, content);
    } catch (e) {
      log(`Parse failed: ${rel} (${e.message})`);
      failed++;
      continue;
    }

    const keyed = assignSymbolKeys(rel, parsed.symbols);
    const fileRetired = [];
    const fileAppeared = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // upsert file; cascade-delete old symbols/edges for this file
      const prevKeys = new Set();
      if (prev) {
        // Read the outgoing keys before the DELETE below destroys them. They
        // are the only evidence that a symbol used to exist here, which is
        // what the rename pass needs to tell "moved" apart from "deleted".
        const outgoing = await client.query(
          `SELECT symbol_key, kind, name, body_fingerprint, entity_id
             FROM symbols WHERE file_id = $1`,
          [prev.id]
        );
        for (const row of outgoing.rows) {
          if (!row.symbol_key) continue;
          prevKeys.add(row.symbol_key);
          fileRetired.push({
            key: row.symbol_key,
            path: rel,
            kind: row.kind,
            name: row.name,
            fingerprint: row.body_fingerprint,
            entityId: row.entity_id,
          });
        }
        await client.query(`DELETE FROM symbols WHERE file_id = $1`, [prev.id]);
        await client.query(`DELETE FROM edges WHERE file_id = $1`, [prev.id]);
      }
      const fileId = await upsertFileRow(client, project, prev, rel, lang, hash, content);

      // insert symbols
      const nameToId = new Map();
      for (const [i, s] of parsed.symbols.entries()) {
        const { key, fingerprint } = keyed[i];
        const sr = await client.query(
          `INSERT INTO symbols (project_id, file_id, name, kind, signature, doc, start_line, end_line, body,
                                symbol_key, body_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [project.id, fileId, s.name, s.kind, s.signature, s.doc, s.startLine, s.endLine, s.body,
           key, fingerprint]
        );
        const id = sr.rows[0].id;
        nameToId.set(s.name, id);
        if (!prevKeys.has(key)) {
          fileAppeared.push({ key, path: rel, kind: s.kind, name: s.name, fingerprint });
        }
        if (embeddingsEnabled()) {
          const embedText = [
            `// ${rel} (${s.kind} ${s.name})`,
            s.doc || "",
            s.body,
          ].join("\n");
          pendingEmbeds.push({ symbolId: id, text: embedText });
        }
      }

      // insert edges (dst resolved later, cross-file)
      for (const r of parsed.relations) {
        const srcId = r.srcName === "@file" ? null : nameToId.get(r.srcName) || null;
        await client.query(
          `INSERT INTO edges (project_id, src, dst_name, relation, file_id, line)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [project.id, srcId, r.dstName, r.relation, fileId, r.line]
        );
      }

      // Give every symbol in this file its durable entity, in two statements
      // regardless of how many symbols there are. Immaterial next to the
      // per-symbol INSERTs above, let alone the embedding round-trips.
      if (keyed.length) {
        await client.query(
          `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
           SELECT $1, $2, 'symbol', u.k, u.title, 'parsed',
                  jsonb_build_object('kind', u.kind, 'path', $3::text, 'fingerprint', u.fp)
             FROM unnest($4::text[], $5::text[], $6::text[], $7::text[]) AS u(k, title, kind, fp)
           ON CONFLICT (project_id, kind, natural_key) DO UPDATE
              SET title      = EXCLUDED.title,
                  data       = entities.data || EXCLUDED.data,
                  deleted_at = NULL,
                  updated_at = now()`,
          [
            project.org_id, project.id, rel,
            keyed.map((k) => k.key),
            parsed.symbols.map((s) => s.name),
            parsed.symbols.map((s) => s.kind),
            keyed.map((k) => k.fingerprint),
          ]
        );
        await client.query(
          `UPDATE symbols s SET entity_id = e.id
             FROM entities e
            WHERE s.file_id = $1
              AND e.project_id = $2 AND e.kind = 'symbol'
              AND e.natural_key = s.symbol_key`,
          [fileId, project.id]
        );
      }

      await client.query("COMMIT");
      // Only after the commit: a rolled-back file changed nothing, and
      // reconciling against keys that were never actually retired would
      // tombstone entities that are still very much alive.
      retired.push(...fileRetired);
      appeared.push(...fileAppeared);
      changed++;
    } catch (e) {
      await client.query("ROLLBACK");
      log(`DB error on ${rel}: ${e.message}`);
      failed++;
    } finally {
      client.release();
    }
  }

  // remove deleted files
  let removed = 0;
  const dropFile = async (relPath, row) => {
    // A file being deleted is the commonest way a symbol "moves": the same
    // function turns up in another file in the same run. Capture the keys
    // before the cascade takes them so the rename pass can see it.
    const outgoing = await pool.query(
      `SELECT symbol_key, kind, name, body_fingerprint, entity_id
         FROM symbols WHERE file_id = $1`,
      [row.id]
    );
    for (const s of outgoing.rows) {
      if (!s.symbol_key) continue;
      retired.push({
        key: s.symbol_key, path: relPath, kind: s.kind, name: s.name,
        fingerprint: s.body_fingerprint, entityId: s.entity_id,
      });
    }
    await pool.query(`DELETE FROM files WHERE id = $1`, [row.id]);
    removed++;
  };

  if (diffResult) {
    for (const relPath of gitDeletedPaths) {
      const row = existing.get(relPath);
      if (row) await dropFile(relPath, row);
    }
  } else {
    for (const [relPath, row] of existing) {
      if (!seen.has(relPath)) await dropFile(relPath, row);
    }
  }

  // resolve edges: match dst_name against symbol names (exact, then method suffix)
  log("Resolving graph edges…");
  await pool.query(
    `UPDATE edges e SET dst = s.id
     FROM symbols s
     WHERE e.project_id = $1 AND s.project_id = $1
       AND e.dst IS NULL AND e.dst_name = s.name`,
    [project.id]
  );
  // "$this->foo(...)" parsed as bare method name → match "Class::foo" suffix
  await pool.query(
    `UPDATE edges e SET dst = s.id
     FROM symbols s
     WHERE e.project_id = $1 AND s.project_id = $1
       AND e.dst IS NULL AND s.kind = 'method'
       AND s.name LIKE '%::' || e.dst_name`,
    [project.id]
  );
  // PHP fully-qualified reference ("\App\Domain\Invoice") against a symbol
  // stored under its namespaced name.
  await pool.query(
    `UPDATE edges e SET dst = s.id
     FROM symbols s
     WHERE e.project_id = $1 AND s.project_id = $1
       AND e.dst IS NULL AND e.dst_name LIKE '\\\\%'
       AND ltrim(e.dst_name, '\\') = s.name`,
    [project.id]
  );
  // Unqualified reference to a namespaced symbol: `new Invoice()` inside
  // (or importing from) App\Domain resolves to App\Domain\Invoice.
  //
  // Symbols carry their namespace but call sites almost never repeat it, so
  // without this pass qualifying PHP names would strand most edges: measured
  // on a real WordPress codebase, exact-match alone resolved 0.4% of targets
  // versus 2.8% before namespaces were recorded at all. Matching on the
  // unqualified suffix restores 2.7%.
  //
  // Only unique matches are linked -- pointing an edge at an arbitrary one of
  // several same-named classes would be worse than leaving it unresolved.
  await pool.query(
    `WITH candidate AS (
       SELECT e.id AS edge_id, min(s.id) AS symbol_id, count(*) AS matches
       FROM edges e
       JOIN symbols s
         ON s.project_id = e.project_id
        AND s.kind <> 'method'
        AND s.name LIKE '%\\\\%'
        AND regexp_replace(s.name, '^.*\\\\', '') = e.dst_name
       WHERE e.project_id = $1 AND e.dst IS NULL
       GROUP BY e.id
     )
     UPDATE edges e SET dst = c.symbol_id
     FROM candidate c
     WHERE e.id = c.edge_id AND c.matches = 1`,
    [project.id]
  );

  // Resolve doc -> symbol mentions once the symbol table for this run has
  // settled. Only unique matches are linked: pointing a document at an
  // arbitrary one of seven same-named functions is worse than not linking it,
  // which is the rule the namespace edge resolver above already follows.
  //
  // Path mentions are deliberately not resolved here -- they stay on
  // documents.mentions under a GIN index. See 0007_documents.sql.
  if (config.docsEnabled) {
    const mentionRes = await pool.query(
      `WITH mention AS (
         SELECT d.entity_id AS doc_id,
                jsonb_array_elements_text(coalesce(d.mentions->'identifiers', '[]'::jsonb)) AS ident
           FROM documents d
          WHERE d.project_id = $1
       ),
       resolved AS (
         SELECT m.doc_id, min(e.id) AS sym_id, count(*) AS matches
           FROM mention m
           JOIN entities e
             ON e.project_id = $1 AND e.kind = 'symbol' AND e.deleted_at IS NULL
            AND (e.title = m.ident OR e.title LIKE '%::' || m.ident)
          GROUP BY m.doc_id, m.ident
       )
       INSERT INTO entity_links (org_id, src_id, dst_id, relation)
       SELECT $2, doc_id, sym_id, 'MENTIONS' FROM resolved WHERE matches = 1
       ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
      [project.id, project.org_id]
    );
    docStats.mentions = mentionRes.rowCount ?? 0;
  }

  const identity = await reconcileIdentity(project, retired, appeared, log);

  let history = null;
  if (config.historyEnabled) {
    try {
      history = await ingestGitHistory(project, root, log);
      if (history.commits) log(`Git history: ${history.commits} commit(s) (${history.mode})`);
    } catch (e) {
      // History is additive knowledge. A repo without git, a shallow clone, or
      // a git binary that isn't there must not fail the code index.
      log(`Git history skipped: ${e.message}`);
      history = { mode: "failed", commits: 0, error: e.message };
    }
  }

  // Rule candidates from this run's docs and fix commits. Only ever writes
  // state='candidate' -- promotion is a human action.
  let rules = null;
  if (config.rulesEnabled) {
    try {
      // Import first: a rule already confirmed in YAML must not be re-proposed
      // as a candidate seconds later by the extractor.
      const imported = await importKnowledge(project.name).catch((e) => {
        log(`Knowledge import skipped: ${e.message}`);
        return null;
      });
      if (imported?.rules || imported?.memories) {
        log(`Knowledge import: ${imported.rules} rule(s), ${imported.memories} memory/ies`);
      }
      rules = await proposeRules(project, log);
      if (imported) rules.imported = imported;
      if (rules.candidates) log(`Rule candidates: ${rules.candidates} pending review`);
    } catch (e) {
      // Extraction is additive knowledge. It must never fail a code index.
      log(`Rule extraction skipped: ${e.message}`);
      rules = { proposed: 0, candidates: 0, error: e.message };
    }
  }

  // embeddings
  if (embeddingsEnabled()) {
    // Heal symbols left without an embedding by an earlier crash or a failed
    // Voyage batch: their file's hash already matched on this run (they were
    // fully committed before whatever interrupted embedding), so the
    // hash-skip above never re-queues them. Re-checking embedding IS NULL
    // directly means a plain re-run of index/reindex retries them, without
    // needing a full reindex or a separate resume command.
    const pendingIds = new Set(pendingEmbeds.map((p) => p.symbolId));
    const missing = await pool.query(
      `SELECT s.id, f.path, s.kind, s.name, s.doc, s.body
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.project_id = $1 AND s.embedding IS NULL`,
      [project.id]
    );
    for (const r of missing.rows) {
      if (pendingIds.has(r.id)) continue;
      pendingEmbeds.push({
        symbolId: r.id,
        text: [`// ${r.path} (${r.kind} ${r.name})`, r.doc || "", r.body].join("\n"),
      });
    }
  }

  if (pendingEmbeds.length) {
    log(`Embedding ${pendingEmbeds.length} symbols…`);
    const EMBED_CHUNK = 64;
    let embedFailed = 0;
    for (let i = 0; i < pendingEmbeds.length; i += EMBED_CHUNK) {
      const chunk = pendingEmbeds.slice(i, i + EMBED_CHUNK);
      let vectors;
      try {
        vectors = await embed(chunk.map((p) => p.text), "document", project.id);
      } catch (e) {
        // Leave this chunk's embeddings NULL rather than losing already-
        // fetched vectors from earlier chunks; the recovery query above
        // will pick these symbols back up on the next index run.
        log(`Embedding batch failed (${chunk.length} symbols): ${e.message}`);
        embedFailed += chunk.length;
        continue;
      }
      for (let j = 0; j < vectors.length; j++) {
        if (!vectors[j]) continue;
        await pool.query(`UPDATE symbols SET embedding = $1 WHERE id = $2`, [
          toVector(vectors[j]),
          chunk[j].symbolId,
        ]);
      }
    }
    if (embedFailed) {
      log(`${embedFailed} symbols left without embeddings; will retry on next index run`);
    }
  }

  // Chunks, on exactly the same terms as symbols: the query is the whole pending
  // set (new, edited, or left over from a crashed run), because whoever wrote
  // the chunk nulled the embedding of any row whose content changed.
  //
  // Joined on entities rather than documents so every chunk-bearing kind is
  // covered -- documents in Phase 2, memories in Phase 3 -- and gated on
  // embeddings alone, since a memory must still embed when doc ingestion is off.
  if (embeddingsEnabled()) {
    const pending = await pool.query(
      `SELECT c.id, c.heading_path, c.content,
              COALESCE(d.path, e.natural_key) AS label,
              COALESCE(d.doc_type, e.kind)    AS sublabel
         FROM chunks c
         JOIN entities e ON e.id = c.entity_id
         LEFT JOIN documents d ON d.entity_id = c.entity_id
        WHERE c.project_id = $1 AND c.embedding IS NULL
        ORDER BY c.id`,
      [project.id]
    );
    if (pending.rows.length) {
      log(`Embedding ${pending.rows.length} chunk(s)…`);
      const CHUNK_BATCH = 32;
      for (let i = 0; i < pending.rows.length; i += CHUNK_BATCH) {
        const batch = pending.rows.slice(i, i + CHUNK_BATCH);
        let vectors;
        try {
          vectors = await embed(
            batch.map((r) =>
              [`// ${r.label} (${r.sublabel})`, r.heading_path || "", r.content].join("\n")
            ),
            "document",
            project.id
          );
        } catch (e) {
          log(`Chunk embedding batch failed (${batch.length} chunks): ${e.message}`);
          continue;
        }
        for (let j = 0; j < vectors.length; j++) {
          if (!vectors[j]) continue;
          await pool.query(`UPDATE chunks SET embedding = $1 WHERE id = $2`, [
            toVector(vectors[j]),
            batch[j].id,
          ]);
          docStats.embedded++;
        }
      }
    }
  }

  // Only advance last_indexed_sha when the whole run succeeded. If any file
  // failed (transient read/parse/DB error), leave the stored sha where it
  // was: the next run will re-diff from the same base, already-succeeded
  // files still skip cheaply via the hash check, and the failed file(s)
  // remain "changed" so they get retried instead of silently falling out of
  // the index forever. `indexed_at` still updates either way — a run did
  // happen, even if only partially.
  if (failed === 0) {
    const newSha = diffResult ? diffResult.headSha : await getHeadSha(root);
    await pool.query(
      `UPDATE projects SET indexed_at = now(), last_indexed_sha = $2 WHERE id = $1`,
      [project.id, newSha]
    );
  } else {
    await pool.query(
      `UPDATE projects SET indexed_at = now() WHERE id = $1`,
      [project.id]
    );
  }
  return {
    mode: diffResult ? "diff" : "full",
    changed, skipped, removed, failed,
    total: filePaths.length, // candidates considered this run, not project size in diff mode
    identity,
    history,
    docs: config.docsEnabled ? docStats : null,
    rules,
  };
}

/**
 * Upsert the `files` row for a path and return its id.
 *
 * Shared by the code and doc branches: `files.hash` is what makes the
 * incremental skip work, and there is no reason for two implementations of it.
 * `language` is updated on the way through, so a path that changes kind (or an
 * old row written before docs were indexed) converges instead of lying.
 */
async function upsertFileRow(client, project, prev, rel, language, hash, content) {
  const loc = content.split("\n").length;
  if (prev) {
    await client.query(
      `UPDATE files SET hash = $1, loc = $2, language = $3, updated_at = now() WHERE id = $4`,
      [hash, loc, language, prev.id]
    );
    return prev.id;
  }
  const fr = await client.query(
    `INSERT INTO files (project_id, path, language, hash, loc)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [project.id, rel, language, hash, loc]
  );
  return fr.rows[0].id;
}

/**
 * Persist one document: its entity, its satellite row, and its chunks.
 *
 * The chunk upsert nulls `embedding` only where `content_hash` actually
 * changed, which is what makes "edit one heading in a 40-section ADR, re-embed
 * one chunk" true rather than aspirational. The run's embedding phase then
 * picks up exactly those rows through its `embedding IS NULL` query -- the same
 * path that heals a crashed run, so there is one recovery mechanism instead of
 * two.
 */
async function writeDocument(client, project, fileId, rel, content, hash) {
  const doc = parseDocument(rel, content, { target: config.docsChunkChars });

  const er = await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, summary, source, data)
     VALUES ($1,$2,'document',$3,$4,$5,'parsed',$6)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            summary    = EXCLUDED.summary,
            data       = entities.data || EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()
     RETURNING id`,
    [
      project.org_id, project.id, rel, doc.title,
      // An ADR's decision is the one line worth carrying on the entity itself;
      // everything else is reachable through the satellite or the chunks.
      doc.adr?.decision ?? null,
      JSON.stringify({ doc_type: doc.docType, path: rel }),
    ]
  );
  const entityId = er.rows[0].id;

  await client.query(
    `INSERT INTO documents (entity_id, org_id, project_id, file_id, path, doc_type, title,
                            frontmatter, adr, mentions, content_hash, chunk_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (project_id, path) DO UPDATE
        SET entity_id    = EXCLUDED.entity_id,
            file_id      = EXCLUDED.file_id,
            doc_type     = EXCLUDED.doc_type,
            title        = EXCLUDED.title,
            frontmatter  = EXCLUDED.frontmatter,
            adr          = EXCLUDED.adr,
            mentions     = EXCLUDED.mentions,
            content_hash = EXCLUDED.content_hash,
            chunk_count  = EXCLUDED.chunk_count,
            updated_at   = now()`,
    [
      entityId, project.org_id, project.id, fileId, rel, doc.docType, doc.title,
      JSON.stringify(doc.frontmatter),
      doc.adr ? JSON.stringify(doc.adr) : null,
      JSON.stringify(doc.mentions),
      hash, doc.chunks.length,
    ]
  );

  if (doc.chunks.length) {
    await client.query(
      `INSERT INTO chunks (org_id, project_id, entity_id, ord, heading_path, content,
                           content_hash, token_estimate)
       SELECT $1, $2, $3, u.ord, u.hp, u.content, u.hash, u.tok
         FROM unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::int[])
              AS u(ord, hp, content, hash, tok)
       ON CONFLICT (entity_id, ord) DO UPDATE
          SET heading_path   = EXCLUDED.heading_path,
              content        = EXCLUDED.content,
              content_hash   = EXCLUDED.content_hash,
              token_estimate = EXCLUDED.token_estimate,
              embedding      = CASE WHEN chunks.content_hash = EXCLUDED.content_hash
                                    THEN chunks.embedding ELSE NULL END`,
      [
        project.org_id, project.id, entityId,
        doc.chunks.map((c) => c.ord),
        doc.chunks.map((c) => c.headingPath),
        doc.chunks.map((c) => c.content),
        doc.chunks.map((c) => c.contentHash),
        doc.chunks.map((c) => c.tokenEstimate),
      ]
    );
  }
  // A document that lost sections leaves higher ords behind.
  await client.query(`DELETE FROM chunks WHERE entity_id = $1 AND ord >= $2`, [
    entityId,
    doc.chunks.length,
  ]);

  return { entityId, chunks: doc.chunks.length };
}

/**
 * Close the identity plane for this run: match renames, then tombstone what
 * genuinely went away.
 *
 * Runs once per index run rather than per file because a rename is only
 * visible from both ends. The per-file transaction has already created a fresh
 * entity for the new key; where that turns out to be a renamed or moved
 * symbol, the fresh entity is discarded and the original is carried over to
 * the new key instead, with the old key kept as an alias. Anything a knowledge
 * row was attached to therefore survives the rename, which is the entire point
 * of the plane.
 */
async function reconcileIdentity(project, retired, appeared, log) {
  const result = { retired: retired.length, appeared: appeared.length, renamed: 0, tombstoned: 0 };
  if (!retired.length) return result;

  // A key that was rewritten in place (file edited, symbol unchanged) shows up
  // in both lists; it never left, so it is neither a rename nor a death.
  const stillPresent = await pool.query(
    `SELECT symbol_key FROM symbols WHERE project_id = $1 AND symbol_key = ANY($2)`,
    [project.id, retired.map((r) => r.key)]
  );
  const alive = new Set(stillPresent.rows.map((r) => r.symbol_key));
  const gone = retired.filter((r) => !alive.has(r.key) && r.entityId);
  if (!gone.length) return result;

  const renames = matchRenames(gone, appeared);
  const renamedOldKeys = new Set(renames.map((r) => r.oldKey));
  const appearedByKey = new Map(appeared.map((a) => [a.key, a]));
  const tombstones = gone.filter((r) => !renamedOldKeys.has(r.key)).map((r) => r.entityId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (renames.length) {
      const oldIds = renames.map((r) => r.entityId);
      const newKeys = renames.map((r) => r.newKey);

      // Discard the entity the per-file pass minted for the new key. It is
      // seconds old and cannot have acquired any links yet; the guard just
      // makes sure a self-match could never delete the entity being kept.
      await client.query(
        `DELETE FROM entities
          WHERE project_id = $1 AND kind = 'symbol'
            AND natural_key = ANY($2) AND NOT (id = ANY($3))`,
        [project.id, newKeys, oldIds]
      );
      // The new key is live again, so it must not also be somebody's alias.
      await client.query(
        `DELETE FROM symbol_aliases WHERE project_id = $1 AND symbol_key = ANY($2)`,
        [project.id, newKeys]
      );
      await client.query(
        // The fingerprint has to be re-stamped, not just the path: a rename
        // matched by kind+name (rather than by fingerprint) is precisely the
        // case where the body changed on the way, and leaving the old hash
        // here would make the next run's match work off stale evidence.
        `UPDATE entities e
            SET natural_key = u.new_key,
                title       = COALESCE(u.new_title, e.title),
                data        = e.data || jsonb_build_object(
                                'path', u.new_path, 'fingerprint', u.new_fp),
                deleted_at  = NULL,
                updated_at  = now()
           FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[])
                AS u(id, new_key, new_path, new_title, new_fp)
          WHERE e.id = u.id AND e.project_id = $1`,
        [
          project.id, oldIds, newKeys,
          renames.map((r) => r.newPath),
          renames.map((r) => appearedByKey.get(r.newKey)?.name ?? null),
          renames.map((r) => appearedByKey.get(r.newKey)?.fingerprint ?? null),
        ]
      );
      await client.query(
        `UPDATE symbols s SET entity_id = u.id
           FROM unnest($2::bigint[], $3::text[]) AS u(id, key)
          WHERE s.project_id = $1 AND s.symbol_key = u.key`,
        [project.id, oldIds, newKeys]
      );
      await client.query(
        `INSERT INTO symbol_aliases (org_id, project_id, entity_id, symbol_key, path, reason)
         SELECT $1, $2, u.id, u.old_key, u.old_path, u.reason
           FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[])
                AS u(id, old_key, old_path, reason)
         ON CONFLICT (project_id, symbol_key) DO UPDATE
            SET entity_id = EXCLUDED.entity_id, reason = EXCLUDED.reason`,
        [
          project.org_id, project.id, oldIds,
          renames.map((r) => r.oldKey),
          renames.map((r) => r.oldPath),
          renames.map((r) => r.reason),
        ]
      );
      result.renamed = renames.length;
    }

    if (tombstones.length) {
      await client.query(
        `UPDATE entities SET deleted_at = now(), updated_at = now()
          WHERE id = ANY($1) AND deleted_at IS NULL`,
        [tombstones]
      );
      result.tombstoned = tombstones.length;
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log(`Identity reconciliation failed: ${e.message}`);
  } finally {
    client.release();
  }

  if (result.renamed) log(`Tracked ${result.renamed} renamed/moved symbol(s)`);
  return result;
}
