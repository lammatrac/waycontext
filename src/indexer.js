import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import { pool, toVector, getOrCreateProject } from "./db.js";
import { parseFile, EXT_LANG } from "./parser.js";
import { embed, embeddingsEnabled } from "./embeddings.js";
import { config } from "./config.js";

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
  const ig = loadGitignore(root);

  const patterns = Object.keys(EXT_LANG).map((ext) => `**/*${ext}`);
  const found = await fg(patterns, { cwd: root, dot: false, ignore: DEFAULT_IGNORES });
  const filePaths = found.filter((p) => !ig.ignores(p));
  log(`Found ${filePaths.length} source files`);

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
  for (const [relPath, row] of existing) {
    if (!seen.has(relPath)) {
      await pool.query(`DELETE FROM files WHERE id = $1`, [row.id]);
      removed++;
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
  if (pendingEmbeds.length) {
    log(`Embedding ${pendingEmbeds.length} symbols…`);
    const vectors = await embed(pendingEmbeds.map((p) => p.text), "document", project.id);
    for (let i = 0; i < pendingEmbeds.length; i++) {
      if (!vectors[i]) continue;
      await pool.query(`UPDATE symbols SET embedding = $1 WHERE id = $2`, [
        toVector(vectors[i]),
        pendingEmbeds[i].symbolId,
      ]);
    }
  }

  await pool.query(`UPDATE projects SET indexed_at = now() WHERE id = $1`, [project.id]);
  return { changed, skipped, removed, failed, total: filePaths.length };
}
