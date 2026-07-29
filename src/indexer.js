import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import { pool, toVector, getOrCreateProject } from "./db.js";
import { parseFile, EXT_LANG } from "./parser.js";
import { embed, embeddingsEnabled } from "./embeddings.js";
import { config } from "./config.js";
import { getChangedFiles, getHeadSha } from "./gitDiff.js";

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
      (p) => EXT_LANG[path.extname(p)] && !ig.ignores(p)
    );
    gitDeletedPaths = diffResult.deleted;
    log(`Git diff since last index: ${filePaths.length} changed, ${gitDeletedPaths.length} deleted`);
  } else {
    const patterns = Object.keys(EXT_LANG).map((ext) => `**/*${ext}`);
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

    const lang = EXT_LANG[path.extname(rel)];
    let parsed;
    try {
      parsed = parseFile(lang, content);
    } catch (e) {
      log(`Parse failed: ${rel} (${e.message})`);
      failed++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // upsert file; cascade-delete old symbols/edges for this file
      let fileId;
      if (prev) {
        await client.query(`DELETE FROM symbols WHERE file_id = $1`, [prev.id]);
        await client.query(`DELETE FROM edges WHERE file_id = $1`, [prev.id]);
        await client.query(
          `UPDATE files SET hash = $1, loc = $2, updated_at = now() WHERE id = $3`,
          [hash, content.split("\n").length, prev.id]
        );
        fileId = prev.id;
      } else {
        const fr = await client.query(
          `INSERT INTO files (project_id, path, language, hash, loc)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [project.id, rel, lang, hash, content.split("\n").length]
        );
        fileId = fr.rows[0].id;
      }

      // insert symbols
      const nameToId = new Map();
      for (const s of parsed.symbols) {
        const sr = await client.query(
          `INSERT INTO symbols (project_id, file_id, name, kind, signature, doc, start_line, end_line, body)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [project.id, fileId, s.name, s.kind, s.signature, s.doc, s.startLine, s.endLine, s.body]
        );
        const id = sr.rows[0].id;
        nameToId.set(s.name, id);
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
      await client.query("COMMIT");
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
  if (diffResult) {
    for (const relPath of gitDeletedPaths) {
      const row = existing.get(relPath);
      if (row) {
        await pool.query(`DELETE FROM files WHERE id = $1`, [row.id]);
        removed++;
      }
    }
  } else {
    for (const [relPath, row] of existing) {
      if (!seen.has(relPath)) {
        await pool.query(`DELETE FROM files WHERE id = $1`, [row.id]);
        removed++;
      }
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
  };
}
