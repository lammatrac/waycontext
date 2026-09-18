import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import picomatch from "picomatch";
import { pool, toVector, getOrCreateProject } from "./db.js";
import { parseFile, EXT_LANG } from "./parser.js";
import { extractPhpUiElements } from "./ui/phpElements.js";
import { extractPhpWpPrimitives } from "./ui/phpWpPrimitives.js";
import { extractPhpHooks } from "./ui/phpHooks.js";
import { extractPhpI18nCalls } from "./ui/phpI18nCalls.js";
import { extractPhpSettingsRenderSites } from "./ui/phpSettingsRender.js";
import { extractPhpShortcodes } from "./ui/phpShortcodes.js";
import { extractPhpBlocks } from "./ui/phpBlocks.js";
import { readBlockManifest } from "./ui/blockManifest.js";
import { discoverCatalogs, resolveKey, resolveKeyAnyDomain } from "./ui/i18nCatalog.js";
import { identityBackfillStatus, backfillProjectIdentity } from "./backfillIdentity.js";
import { embed, embeddingsEnabled } from "./embeddings.js";
import { config } from "./config.js";
import { getChangedFiles, getHeadSha } from "./gitDiff.js";
import { assignSymbolKeys, matchRenames } from "./identity.js";
import { ingestGitHistory } from "./knowledge/gitHistory.js";
import { parseDocument } from "./knowledge/docs.js";
import { proposeRules } from "./knowledge/rules.js";
import { importKnowledge } from "./knowledge/knowledgeFiles.js";
import { deriveIntelligence } from "./knowledge/derive.js";

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

    // A first index that matched nothing is almost always a supported-language
    // mismatch -- pointed at a Rust or Java repo, or at a directory above (or
    // beside) the actual source. Reporting success with zero symbols looks like
    // WayContext worked, and the failure only surfaces later as searches that
    // return nothing. Only on a full scan: an incremental run legitimately finds
    // no changed files, and that is the common case, not a problem.
    if (!filePaths.length) {
      log(
        `No supported source files found under ${root}. ` +
        // Listed from EXT_LANG rather than written out, so adding a grammar can't
        // leave this message claiming the old set.
        `WayContext indexes ${Object.keys(EXT_LANG).join(", ")}. ` +
        `Check the path points at the source root, and that .gitignore isn't excluding it.`
      );
    }
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
      // Postgres text columns cannot hold 0x00 at all, so one stray NUL byte
      // (a minified asset, a half-binary fixture) failed the whole file -- and
      // because a failed file holds back last_indexed_sha, every later
      // incremental run retried the same diff forever. Strip before hashing so
      // the stored hash describes what we actually stored.
      content = fs.readFileSync(abs, "utf8").replaceAll(String.fromCharCode(0), "");
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

      // UI intelligence, Increment 1A: PHP-emitted literal HTML (REQ-001/
      // REQ-002) plus WP UI-primitive callsites (REQ-016/REQ-017/REQ-018,
      // phase 1A-2). Gated so a non-PHP or UI-disabled project pays nothing.
      if (config.uiEnabled && lang === "php") {
        let elements = [];
        try {
          elements = extractPhpUiElements(content);
        } catch (e) {
          // Additive knowledge on top of a successful code parse -- a bug in
          // the second-pass HTML extraction must not fail the file's index.
          // AC-012 (1A-9): the diagnostic names the adapter, file, error
          // class and message so it's actionable, not just a breadcrumb.
          log(`UI adapter "phpElements" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        let primitives = { elements: [], screens: [], settingsSections: [], settingsFields: [] };
        try {
          primitives = extractPhpWpPrimitives(content);
        } catch (e) {
          log(`UI adapter "phpWpPrimitives" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        // submit_button() is button-shaped ui_element (REQ-016) -- same write
        // path/lifecycle as literal-HTML elements, merged before one write.
        await writeUiElements(client, project, rel, elements.concat(primitives.elements));
        await writeUiWpPrimitives(
          client, project, fileId, rel,
          primitives.screens, primitives.settingsSections, primitives.settingsFields
        );

        // Phase 1A-3 (REQ-014): WordPress hook call sites. Written as
        // per-file staging facts only -- project-wide LISTENS_TO/FIRED_BY
        // resolution happens once for the whole project, in
        // resolveHookGraph() below, after every file's symbols have settled.
        let hooks = { listens: [], fires: [] };
        try {
          hooks = extractPhpHooks(content);
        } catch (e) {
          log(`UI adapter "phpHooks" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        await writeUiHookSites(client, project, rel, hooks.listens, hooks.fires);

        // Phase 1A-4 (REQ-003/REQ-004): WordPress gettext i18n call sites.
        // Written as per-file staging facts only, same reasoning as hook
        // sites above -- project-wide catalog resolution happens once for
        // the whole project, in resolveI18nGraph() below, after every
        // file's symbols/i18n call sites have settled.
        let i18nCalls = [];
        try {
          i18nCalls = extractPhpI18nCalls(content);
        } catch (e) {
          log(`UI adapter "phpI18nCalls" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        await writeUiI18nCallSites(client, project, rel, i18nCalls);

        // Phase 1A-6 (REQ-018 completion): do_settings_sections() call
        // sites, staged project-wide so resolveUiRelations() below can
        // complete the cross-file section/field -> render-site correlation
        // 1A-2 only ever resolved same-file (contracts.md "Phase 1A-2" /
        // "Phase 1A-6" -- see plan.md "Reality check" for why this staging
        // entity didn't already exist).
        let settingsRenderSites = [];
        try {
          settingsRenderSites = extractPhpSettingsRenderSites(content);
        } catch (e) {
          log(`UI adapter "phpSettingsRender" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        await writeUiSettingsRenderSites(client, project, rel, settingsRenderSites);

        // Phase 1B-1 (REQ-023): WordPress shortcode registration call
        // sites. Written as per-file staging facts only, same reasoning as
        // hook sites above -- `shortcode` is a project-wide-keyed concept
        // (one entity per tag, mirroring `hook`'s own precedent: WordPress
        // itself allows only one callback per tag), so project-wide
        // upsert/tombstone lifecycle happens once for the whole project, in
        // resolveShortcodeGraph() below, after every file's shortcode call
        // sites have settled.
        let shortcodes = [];
        try {
          shortcodes = extractPhpShortcodes(content);
        } catch (e) {
          log(`UI adapter "phpShortcodes" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        await writeUiShortcodeSites(client, project, rel, shortcodes);

        // Phase 1B-2 (REQ-024): Gutenberg static block registration call
        // sites. Written as per-file staging facts only, same reasoning as
        // shortcode sites above -- `block` is a project-wide-keyed concept
        // (one entity per namespace declared in block.json, mirroring
        // `hook`/`shortcode`'s own precedent: WordPress's block registry is
        // namespace-unique), so project-wide upsert/tombstone lifecycle
        // happens once for the whole project, in resolveBlockGraph() below,
        // after every file's block call sites have settled. Unlike every
        // other sibling extractor, resolving a call site fully requires a
        // *second* filesystem read (block.json itself, for its declared
        // namespace/title/category) -- done here in writeUiBlockSites(), not
        // inside phpBlocks.js, which stays pure/DB-free like every sibling
        // (mirrors i18nCatalog.js's own "disk I/O lives in its own module,
        // called from indexer.js with an explicit root" separation).
        let blocks = [];
        try {
          blocks = extractPhpBlocks(content);
        } catch (e) {
          log(`UI adapter "phpBlocks" extraction skipped for ${rel}: ${e.constructor.name}: ${e.message}`);
        }
        await writeUiBlockSites(client, project, root, rel, blocks);
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
    // A deleted file's UI elements must not linger as live entities -- same
    // tombstone writeUiElements()/writeUiWpPrimitives() apply on every
    // re-index of a surviving file.
    if (config.uiEnabled) {
      await pool.query(
        `UPDATE entities SET deleted_at = now(), updated_at = now()
          WHERE project_id = $1
            AND kind IN ('ui_element', 'ui_screen', 'ui_settings_section', 'ui_settings_field', 'hook_site', 'i18n_call_site', 'settings_render_site', 'shortcode_site', 'block_site')
            AND data->>'source_path' = $2 AND deleted_at IS NULL`,
        [project.id, relPath]
      );
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

  // UI intelligence, phases 1A-3/1A-4 (REQ-014, REQ-003/REQ-004): the
  // project-wide hook (LISTENS_TO/FIRED_BY) and i18n (TRANSLATION_OF/
  // TRANSLATION_USED_AT) graphs used to be resolved here, right after edge
  // resolution. Moved below reconcileIdentity()/the identity preflight
  // (1A-9 fix, AC-018): both graphs join against `symbols.entity_id IS NOT
  // NULL`, and a symbol whose file wasn't reprocessed this run (unchanged
  // hash) only gets its entity_id backfilled by identityPreflight's
  // backfillProjectIdentity() call, which used to run AFTER this point --
  // so a same-run backfill could never be reflected in that run's own
  // LISTENS_TO/FIRED_BY (and therefore HANDLED_BY, which reuses
  // LISTENS_TO), only on the following run. See contracts.md "Phase 1A-9"
  // for the reproduction and why this is the minimal fix (no change to
  // either resolver's own logic, only where in runIndex() they're called).

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

  // UI intelligence, Increment 1A, phase 1A-5 (REQ-027): project-level
  // identity preflight, once per index_project job (never per file) --
  // positioned right after reconcileIdentity() and before the UI relation
  // post-pass (1A-6: DEFINED_BY/HANDLED_BY etc, not wired in as of this
  // phase -- when it is, it should read `identityPreflight` directly rather
  // than re-deriving identity completeness itself; see contracts.md
  // "Phase 1A-5" for the full handoff shape). Gated by config.uiEnabled,
  // same as the hooks/i18n post-passes above: this preflight exists
  // specifically to unblock UI relation resolution, so a project with the
  // UI feature off has no relation to unblock.
  let identityPreflight = null;
  if (config.uiEnabled) {
    try {
      identityPreflight = await runIdentityPreflight(project, log);
      if (!identityPreflight.complete) {
        log(`Identity preflight: identity incomplete for "${project.name}" -- ` +
          `UI relations depending on it will be marked unresolved.`);
      }
    } catch (e) {
      // The preflight itself must not fail the code index either (REQ-027) --
      // same additive-subsystem contract as every other optional pass in
      // this function.
      log(`Identity preflight skipped: ${e.message}`);
      identityPreflight = {
        complete: false,
        backfillRan: false,
        backfillResult: null,
        diagnostics: [identityIncompleteDiagnostic(project, e.message)],
      };
    }
  }

  // UI intelligence, Increment 1A, phase 1A-3 (REQ-014): resolve the
  // WordPress hook graph project-wide now that this run's `symbols` table
  // (including anything the identity preflight above just backfilled) has
  // settled. Runs once per index_project job, not per file -- see
  // resolveHookGraph()'s doc comment and contracts.md "Phase 1A-3" for why
  // this recomputes the whole LISTENS_TO/FIRED_BY graph from `hook_site`
  // staging facts rather than diffing incrementally. Positioned after the
  // identity preflight (not right after edge resolution, where 1A-3/1A-4
  // originally put it) -- see 1A-9's fix note above the doc-mentions block.
  let hooks = null;
  if (config.uiEnabled) {
    try {
      hooks = await resolveHookGraph(project, log);
      if (hooks) {
        log(`Hook graph: ${hooks.hookCount} hook(s), ${hooks.listensTo} LISTENS_TO, ${hooks.firedBy} FIRED_BY`);
      }
    } catch (e) {
      // Additive knowledge on top of a successful code parse -- a bug here
      // must not fail the code index, same contract as every other additive
      // subsystem in this function.
      log(`Hook graph resolution skipped: ${e.message}`);
      hooks = { error: e.message };
    }
  }

  // UI intelligence, Increment 1A, phase 1A-4 (REQ-003/REQ-004): resolve
  // WordPress gettext i18n keys against the project's .po/.mo catalogs,
  // project-wide, same call position/gating/try-catch style as
  // resolveHookGraph() above (contracts.md "Phase 1A-3" established this
  // pattern; reused rather than inventing a second one). Same 1A-9
  // reordering rationale as resolveHookGraph() above -- TRANSLATION_USED_AT
  // also joins against symbols.entity_id IS NOT NULL.
  let i18n = null;
  if (config.uiEnabled) {
    try {
      i18n = await resolveI18nGraph(project, root, log);
      if (i18n) {
        log(`i18n graph: ${i18n.keyCount} key(s), ${i18n.translationOf} TRANSLATION_OF, ${i18n.usedAt} TRANSLATION_USED_AT`);
      }
    } catch (e) {
      // Additive knowledge on top of a successful code parse -- a bug here
      // must not fail the code index, same contract as every other additive
      // subsystem in this function.
      log(`i18n graph resolution skipped: ${e.message}`);
      i18n = { error: e.message };
    }
  }

  // UI intelligence, Increment 1B, phase 1B-1 (REQ-023): resolve the
  // WordPress shortcode graph project-wide, same call position/gating/
  // try-catch style as resolveHookGraph()/resolveI18nGraph() above (same
  // reason: this join needs symbols.entity_id to be settled, including
  // anything the identity preflight above just backfilled -- see 1A-9's
  // Bug #1 fix note above the doc-mentions block for why this must sit
  // after the identity preflight, not before it).
  let shortcodes = null;
  if (config.uiEnabled) {
    try {
      shortcodes = await resolveShortcodeGraph(project, log);
      if (shortcodes) {
        log(`Shortcode graph: ${shortcodes.shortcodeCount} shortcode(s), ${shortcodes.registeredAt} REGISTERED_AT, ${shortcodes.renderedBy} RENDERED_BY`);
      }
    } catch (e) {
      // Additive knowledge on top of a successful code parse -- a bug here
      // must not fail the code index, same contract as every other additive
      // subsystem in this function.
      log(`Shortcode graph resolution skipped: ${e.message}`);
      shortcodes = { error: e.message };
    }
  }

  // UI intelligence, Increment 1B, phase 1B-2 (REQ-024): resolve the
  // Gutenberg static block-registration graph project-wide, same call
  // position/gating/try-catch style as resolveHookGraph()/resolveI18nGraph()/
  // resolveShortcodeGraph() above (same reason: this join needs
  // symbols.entity_id to be settled, including anything the identity
  // preflight above just backfilled -- see 1A-9's Bug #1 fix note).
  let blocks = null;
  if (config.uiEnabled) {
    try {
      blocks = await resolveBlockGraph(project, log);
      if (blocks) {
        log(`Block graph: ${blocks.blockCount} block(s), ${blocks.definedIn} DEFINED_IN, ${blocks.renderedBy} RENDERED_BY`);
      }
    } catch (e) {
      // Additive knowledge on top of a successful code parse -- a bug here
      // must not fail the code index, same contract as every other additive
      // subsystem in this function.
      log(`Block graph resolution skipped: ${e.message}`);
      blocks = { error: e.message };
    }
  }

  // UI intelligence, Increment 1A, phase 1A-6 (REQ-006/013/015/019/020/021/
  // 022): cross-file UI relation post-pass -- ui_component materialization,
  // DEFINED_BY/HANDLED_BY, CONTAINS/RENDERS/RENDERED_ON, ownership
  // classification. Runs once per index_project job, right after the
  // identity preflight above (it reads `identityPreflight` to decide
  // whether DEFINED_BY/HANDLED_BY misses are "unresolved" or
  // "unknown_render" -- see contracts.md "Phase 1A-6"). Gated by
  // config.uiEnabled, same as every other project-wide UI pass; wrapped in
  // its own try/catch -- a bug here must not fail the code index (REQ-021).
  let uiRelations = null;
  if (config.uiEnabled) {
    try {
      uiRelations = await resolveUiRelations(project, identityPreflight, log);
    } catch (e) {
      log(`UI relation post-pass skipped: ${e.message}`);
      uiRelations = { error: e.message };
    }
  }

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
  // Derived intelligence runs last, and after the sha update above on purpose:
  // its watermark is that sha, so computing before the update would record a
  // watermark one run behind and recompute everything again next time.
  let derived = null;
  try {
    derived = await deriveIntelligence(project, log);
  } catch (e) {
    // Same contract as history and rules: additive knowledge never fails a
    // code index.
    log(`Derivation skipped: ${e.message}`);
    derived = { error: e.message };
  }

  return {
    mode: diffResult ? "diff" : "full",
    changed, skipped, removed, failed,
    total: filePaths.length, // candidates considered this run, not project size in diff mode
    identity,
    identityPreflight,
    uiRelations,
    history,
    docs: config.docsEnabled ? docStats : null,
    rules,
    derived,
    hooks,
    i18n,
    shortcodes,
    blocks,
  };
}

/**
 * UI intelligence, Increment 1A, phase 1A-5 (REQ-027): build the
 * `UI_IDENTITY_INCOMPLETE` diagnostic 1A-6/1A-9 test against (contracts.md
 * "Phase 1A-5" -- the richer `{code, severity, affected_feature, message,
 * recommended_action}` shape was chosen over this codebase's existing
 * `{error: e.message}` additive-subsystem convention specifically because
 * REQ-027's own text requires naming the affected feature and recommending
 * a remediation command, neither of which `{error}` carries).
 */
function identityIncompleteDiagnostic(project, detail) {
  return {
    code: "UI_IDENTITY_INCOMPLETE",
    severity: "warning",
    // Fixed string: at preflight time no specific DEFINED_BY/HANDLED_BY
    // relation is known yet -- only 1A-6's own post-pass, once built, can
    // name a specific relation/entity, and it appends its own diagnostic to
    // do so rather than mutating this one.
    affected_feature: "ui_relations",
    message: `Identity is incomplete for project "${project.name}": ${detail}. ` +
      `DEFINED_BY/HANDLED_BY relations depending on unresolved identity will ` +
      `be marked unresolved rather than fabricated or silently retried.`,
    recommended_action: "waycontext backfill-identity",
  };
}

/**
 * UI intelligence, Increment 1A, phase 1A-5 (REQ-027): run once per
 * `index_project` job, project-level -- never per file. Reuses the existing
 * identityBackfillStatus()/backfillProjectIdentity() from
 * src/backfillIdentity.js verbatim; see that file's own doc comment for why
 * the backfill is a resumable, batched command rather than folded into a
 * migration. Safe to call unconditionally inside the same per-project
 * pg_advisory_lock() indexProject() already holds around the whole
 * runIndex() call -- backfillProjectIdentity()'s own documented
 * precondition ("safe to run while nothing else is indexing that project",
 * src/backfillIdentity.js:15) is already satisfied; no new lock is needed.
 *
 * @returns {{complete:boolean, backfillRan:boolean, backfillResult:object|null, diagnostics:object[]}}
 */
async function runIdentityPreflight(project, log) {
  const before = await identityBackfillStatus(project.id);
  const beforeRow = before.find((r) => r.id === project.id);
  if (!beforeRow || beforeRow.unlinked === 0) {
    // Nothing to do: either the project has no symbols yet, or every symbol
    // already has an entity_id.
    return { complete: true, backfillRan: false, backfillResult: null, diagnostics: [] };
  }

  log(`Identity preflight: ${beforeRow.unlinked} symbol(s) in "${project.name}" ` +
    `missing entity_id, running backfill…`);
  let backfillResult = null;
  let backfillError = null;
  try {
    backfillResult = await backfillProjectIdentity(project, { log });
  } catch (e) {
    // The backfill's own failure must not fail the overall indexing job
    // (REQ-027) -- code indexing and UI entity creation already completed
    // by this point in the pipeline.
    backfillError = e.message;
  }

  // Re-check rather than trust the backfill's own report: a successful call
  // can still leave rows unlinked (e.g. a symbol whose file_id no longer
  // resolves to a files row), and a failed call obviously leaves everything
  // it hadn't reached yet.
  const after = await identityBackfillStatus(project.id);
  const afterRow = after.find((r) => r.id === project.id);
  const stillUnlinked = afterRow ? afterRow.unlinked : 0;
  const complete = stillUnlinked === 0 && !backfillError;

  const diagnostics = complete
    ? []
    : [identityIncompleteDiagnostic(
        project,
        backfillError
          ? `backfill failed (${stillUnlinked} symbol(s) still missing entity_id): ${backfillError}`
          : `${stillUnlinked} symbol(s) still missing entity_id after backfill`
      )];

  return { complete, backfillRan: true, backfillResult, diagnostics };
}

/**
 * Persist one PHP file's extracted UI elements (Increment 1A, REQ-001/REQ-002).
 *
 * Written as entities of kind 'ui_element', never symbols/edges (contracts.md
 * "Fixed by the spec"). Called inside the same per-file transaction as the
 * symbol/edge writes, gated by config.uiEnabled.
 *
 * Lifecycle: every previously-recorded ui_element entity for this path is
 * tombstoned first, then the freshly-extracted set is upserted -- an element
 * still present un-tombstones (ON CONFLICT ... deleted_at = NULL) instead of
 * duplicating; one edited or removed out of the file stays tombstoned rather
 * than lingering as a live entity forever. dropFile() below does the same
 * tombstone for a file that disappears entirely.
 */
async function writeUiElements(client, project, rel, elements) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'ui_element'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!elements.length) return;

  // element_id format is fixed by REQ-020/contracts.md:
  //   ui:<project_id>:<framework>:<source_path>:<component_identity>:<element_fingerprint>
  // <project_id> here is the project's *name*, not entities.id or the numeric
  // projects.id -- every other MCP-facing identifier in this codebase takes a
  // project by name, and element_id is meant to be self-describing to a
  // caller that only has the row's data, not its FK columns.
  const seen = new Map(); // content fingerprint -> count, disambiguates identical siblings under one owner
  const keys = [];
  const titles = [];
  const datas = [];
  for (const el of elements) {
    const sig = sha256(
      `${el.tag}|${el.text}|${el.role ?? ""}|${el.ariaLabel ?? ""}|${el.title ?? ""}` +
      `|${el.placeholder ?? ""}|${el.alt ?? ""}|${el.name ?? ""}|${el.dataTestId ?? ""}`
    ).slice(0, 12);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    const fingerprint = n > 1 ? `${sig}-${n}` : sig;
    const elementId = `ui:${project.name}:php:${rel}:${el.owner}:${fingerprint}`;
    keys.push(elementId);
    titles.push(el.text || el.tag);
    datas.push(JSON.stringify({
      element_id: elementId,
      framework: "php",
      source_path: rel,
      owner: el.owner,
      line: el.line,
      tag: el.tag,
      type: el.type,
      role: el.role,
      text: el.text,
      text_source: el.textSource,
      aria_label: el.ariaLabel,
      title_attr: el.title,
      placeholder: el.placeholder,
      alt: el.alt,
      name: el.name,
      data_testid: el.dataTestId,
      has_dynamic_text: el.hasDynamicText,
      i18n_key: el.i18nKey ?? null,
      extraction: el.extraction,
    }));
  }

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'ui_element', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

/**
 * Persist one PHP file's WordPress UI-primitive registrations (Increment 1A,
 * phase 1A-2 -- REQ-017/REQ-018): `ui_screen` / `ui_settings_section` /
 * `ui_settings_field` entities, plus their `REGISTERED_AT`/`RENDERED_BY`
 * entity_links. (`submit_button()`'s REQ-016 output is a plain `ui_element`
 * record, merged by the caller into writeUiElements()'s input -- it needs no
 * separate write path.)
 *
 * Same lifecycle as writeUiElements(): every previously-recorded entity of
 * these three kinds for this path is tombstoned first, then the
 * freshly-extracted set is upserted.
 *
 * Owner/callback -> symbol resolution is in-file only (Q-003's bound, same
 * as everywhere else in this phase): this file's own symbols were already
 * written earlier in this same transaction, keyed by exactly the name
 * convention (bare name, or "Class::method" for a method -- src/parser.js)
 * that src/ui/phpWpPrimitives.js's owner/callable resolution also produces,
 * so a plain string match against `symbols.name` is sufficient. A callback
 * or owner that isn't defined in this same file (a very common WP pattern --
 * settings registered in one file, rendered from another) is left
 * unresolved here; the raw name stays in `data` for 1A-6/1A-7 to complete
 * with project-wide resolution. No relation is ever fabricated toward a
 * name that doesn't resolve (REQ-026's spirit).
 */
async function writeUiWpPrimitives(client, project, fileId, rel, screens, settingsSections, settingsFields) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1
        AND kind IN ('ui_screen', 'ui_settings_section', 'ui_settings_field')
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!screens.length && !settingsSections.length && !settingsFields.length) return;

  const symRes = await client.query(
    `SELECT name, entity_id FROM symbols WHERE file_id = $1 AND entity_id IS NOT NULL`,
    [fileId]
  );
  const nameToEntityId = new Map(symRes.rows.map((r) => [r.name, r.entity_id]));

  const linkSrc = [], linkDst = [], linkRel = [];
  const addLink = (srcId, name, relation) => {
    if (!name) return;
    const dstId = nameToEntityId.get(name);
    if (!dstId) return;
    linkSrc.push(srcId); linkDst.push(dstId); linkRel.push(relation);
  };

  const upsertRows = async (kind, keys, titles, datas) => {
    const res = await client.query(
      `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
       SELECT $1, $2, $3, u.k, u.title, 'parsed', u.data::jsonb
         FROM unnest($4::text[], $5::text[], $6::text[]) AS u(k, title, data)
       ON CONFLICT (project_id, kind, natural_key) DO UPDATE
          SET title      = EXCLUDED.title,
              data       = EXCLUDED.data,
              deleted_at = NULL,
              updated_at = now()
       RETURNING id, natural_key`,
      [project.org_id, project.id, kind, keys, titles, datas]
    );
    return new Map(res.rows.map((row) => [row.natural_key, row.id]));
  };

  // Content-fingerprint disambiguation, one `seen` map per kind (natural_key
  // uniqueness is scoped to (project_id, kind, natural_key), same as
  // writeUiElements()).
  const fingerprint = (seen, sig) => {
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    return n > 1 ? `${sig}-${n}` : sig;
  };

  if (screens.length) {
    const seen = new Map();
    const keys = [], titles = [], datas = [];
    for (const s of screens) {
      const sig = sha256(`${s.registrationFn}|${s.slug ?? ""}|${s.pageTitle ?? ""}|${s.menuTitle ?? ""}|${s.parentSlug ?? ""}`).slice(0, 12);
      const fp = fingerprint(seen, sig);
      const id = `ui:${project.name}:php:${rel}:${s.owner}:${fp}`;
      const route = s.slug ? `admin.php?page=${s.slug}` : null;
      keys.push(id);
      titles.push(s.pageTitle || s.menuTitle || s.slug || "screen");
      datas.push(JSON.stringify({
        screen_id: id, framework: "php", source_path: rel, owner: s.owner, line: s.line,
        registration_fn: s.registrationFn,
        menu_title: s.menuTitle, page_title: s.pageTitle, menu_slug: s.slug,
        parent_slug: s.parentSlug, capability: s.capability,
        route, renderer: s.renderer, has_dynamic_args: s.hasDynamicArgs,
      }));
    }
    const idByKey = await upsertRows("ui_screen", keys, titles, datas);
    screens.forEach((s, i) => {
      const entityId = idByKey.get(keys[i]);
      if (!entityId) return;
      addLink(entityId, s.owner, "REGISTERED_AT");
      addLink(entityId, s.renderer, "RENDERED_BY");
    });
  }

  if (settingsSections.length) {
    const seen = new Map();
    const keys = [], titles = [], datas = [];
    for (const s of settingsSections) {
      const sig = sha256(`add_settings_section|${s.sectionId ?? ""}|${s.page ?? ""}|${s.title ?? ""}`).slice(0, 12);
      const fp = fingerprint(seen, sig);
      const id = `ui:${project.name}:php:${rel}:${s.owner}:${fp}`;
      keys.push(id);
      titles.push(s.title || s.sectionId || "settings_section");
      datas.push(JSON.stringify({
        settings_id: id, framework: "php", source_path: rel, owner: s.owner, line: s.line,
        registration_fn: s.registrationFn,
        section_id: s.sectionId, title: s.title, page: s.page, callback: s.callback,
        has_dynamic_args: s.hasDynamicArgs, rendered_at: s.renderedAt,
      }));
    }
    const idByKey = await upsertRows("ui_settings_section", keys, titles, datas);
    settingsSections.forEach((s, i) => {
      const entityId = idByKey.get(keys[i]);
      if (!entityId) return;
      addLink(entityId, s.owner, "REGISTERED_AT");
      addLink(entityId, s.callback, "RENDERED_BY");
    });
  }

  if (settingsFields.length) {
    const seen = new Map();
    const keys = [], titles = [], datas = [];
    for (const f of settingsFields) {
      const sig = sha256(`add_settings_field|${f.fieldId ?? ""}|${f.page ?? ""}|${f.section ?? ""}|${f.title ?? ""}`).slice(0, 12);
      const fp = fingerprint(seen, sig);
      const id = `ui:${project.name}:php:${rel}:${f.owner}:${fp}`;
      keys.push(id);
      titles.push(f.title || f.fieldId || "settings_field");
      datas.push(JSON.stringify({
        settings_id: id, framework: "php", source_path: rel, owner: f.owner, line: f.line,
        registration_fn: f.registrationFn,
        field_id: f.fieldId, title: f.title, page: f.page, section: f.section,
        callback: f.callback, label_for: f.labelFor,
        has_dynamic_args: f.hasDynamicArgs, rendered_at: f.renderedAt,
      }));
    }
    const idByKey = await upsertRows("ui_settings_field", keys, titles, datas);
    settingsFields.forEach((f, i) => {
      const entityId = idByKey.get(keys[i]);
      if (!entityId) return;
      addLink(entityId, f.owner, "REGISTERED_AT");
      addLink(entityId, f.callback, "RENDERED_BY");
    });
  }

  if (linkSrc.length) {
    await client.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
       SELECT $1, s, d, r FROM unnest($2::bigint[], $3::bigint[], $4::text[]) AS u(s, d, r)
       ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
      [project.org_id, linkSrc, linkDst, linkRel]
    );
  }
}

/**
 * Persist one PHP file's WordPress hook call sites (Increment 1A, phase
 * 1A-3, REQ-014) as `hook_site` staging entities -- one row per
 * add_action/add_filter/do_action/apply_filters call site found in this
 * file by src/ui/phpHooks.js.
 *
 * `hook_site` is an internal-only entity kind: it is never returned by any
 * MCP operation and isn't part of REQ-025's fixed `entities.kind` list
 * (contracts.md). It exists purely so resolveHookGraph()'s project-wide
 * post-pass can see every file's hook call sites without re-parsing PHP
 * source on every index_project run -- see contracts.md "Phase 1A-3" for
 * the full reasoning (why per-file writes stop at staging facts instead of
 * writing `hook`/LISTENS_TO/FIRED_BY directly).
 *
 * Same tombstone-then-upsert lifecycle as writeUiElements()/
 * writeUiWpPrimitives(): every previously-recorded hook_site for this path
 * is tombstoned first, then the freshly-extracted set is upserted.
 */
async function writeUiHookSites(client, project, rel, listens, fires) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'hook_site'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!listens.length && !fires.length) return;

  const seen = new Map(); // content fingerprint -> count, disambiguates identical siblings under one owner
  const keys = [];
  const titles = [];
  const datas = [];
  const pushSite = (direction, owner, line, sig, extra) => {
    const digest = sha256(sig).slice(0, 12);
    const n = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, n);
    const fingerprint = n > 1 ? `${digest}-${n}` : digest;
    keys.push(`hooksite:${project.name}:php:${rel}:${owner}:${fingerprint}`);
    titles.push(extra.hook_name);
    datas.push(JSON.stringify({ source_path: rel, owner, line, direction, ...extra }));
  };
  for (const l of listens) {
    pushSite(
      "listen", l.owner, l.line,
      `listen|${l.hookName}|${l.callback ?? ""}|${l.registrationFn}|${l.owner}|${l.line}`,
      { hook_name: l.hookName, registration_fn: l.registrationFn, callback: l.callback }
    );
  }
  for (const f of fires) {
    pushSite(
      "fire", f.owner, f.line,
      `fire|${f.hookName}|${f.firingFn}|${f.owner}|${f.line}`,
      { hook_name: f.hookName, firing_fn: f.firingFn }
    );
  }

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'hook_site', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

/**
 * Persist one PHP file's WordPress gettext i18n call sites (Increment 1A,
 * phase 1A-4, REQ-003/REQ-004) as `i18n_call_site` staging entities -- one
 * row per recognized `__`/`_e`/`esc_html__`/etc. call found in this file by
 * src/ui/phpI18nCalls.js.
 *
 * `i18n_call_site` is an internal-only entity kind, same status as
 * `hook_site` (contracts.md "Phase 1A-3"): never returned by any MCP
 * operation, not part of REQ-025's fixed `entities.kind` list. It exists
 * purely so resolveI18nGraph()'s project-wide post-pass can see every
 * file's i18n call sites (including their `$domain`/`$msgctxt` arguments,
 * which 1A-1's `ui_element.data.i18n_key` never captured) without
 * re-parsing PHP source on every index_project run.
 *
 * Same tombstone-then-upsert lifecycle as writeUiHookSites().
 */
async function writeUiI18nCallSites(client, project, rel, calls) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'i18n_call_site'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!calls.length) return;

  const seen = new Map(); // content fingerprint -> count, disambiguates identical siblings under one owner
  const keys = [];
  const titles = [];
  const datas = [];
  for (const c of calls) {
    const sig = sha256(`${c.wrapper}|${c.msgid}|${c.msgctxt ?? ""}|${c.domain ?? ""}|${c.owner}|${c.line}`).slice(0, 12);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    const fingerprint = n > 1 ? `${sig}-${n}` : sig;
    keys.push(`i18nsite:${project.name}:php:${rel}:${c.owner}:${fingerprint}`);
    titles.push(c.msgid);
    datas.push(JSON.stringify({
      source_path: rel, owner: c.owner, line: c.line,
      wrapper: c.wrapper, msgid: c.msgid, msgctxt: c.msgctxt, domain: c.domain,
    }));
  }

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'i18n_call_site', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

/**
 * Project-wide WordPress hook graph resolution (REQ-014, EDGE-012).
 *
 * Runs once per index_project job (called from runIndex, not per file),
 * after this run's `symbols` table has settled. Reads the project's live
 * `hook_site` staging entities (written per-file by writeUiHookSites()
 * above) and derives:
 *
 *   - one generic `hook` entity per distinct hook name a live hook_site
 *     references (upserted; tombstoned once no live hook_site references it
 *     anymore).
 *   - FIRED_BY (hook -> firing symbol): matched within the firing call
 *     site's own file only. The firing symbol (the function/method
 *     enclosing the do_action/apply_filters call) is always resolvable
 *     there -- no cross-file join is needed for this direction. When
 *     nothing matches (owner is the "@file" sentinel, or the firing site is
 *     WordPress core / an unindexed file), no relation is written --
 *     REQ-026's no-fabrication rule.
 *   - LISTENS_TO (callback symbol -> hook): matched project-wide by exact
 *     `symbols.name`, not scoped to the registering call site's own file --
 *     this is the genuinely project-wide part EDGE-012 requires (a hook
 *     fired by one plugin/theme, handled by a callback defined in a
 *     different one). Only a *unique* symbol-name match is linked, the same
 *     "only unique matches are linked" discipline the namespace edge
 *     resolution pass above already applies to `edges` -- pointing a
 *     LISTENS_TO at an arbitrary one of several same-named methods would be
 *     worse than leaving it unresolved.
 *
 * Recomputed in full on every run (delete existing LISTENS_TO/FIRED_BY for
 * this project's hooks, then reinsert) rather than diffed incrementally --
 * see contracts.md "Phase 1A-3" for the cost/simplicity tradeoff.
 */
async function resolveHookGraph(project, log) {
  // Upsert a `hook` entity for every distinct hook name a live hook_site
  // references. natural_key is keyed by hook *name* alone (project-wide),
  // not by call site -- unlike ui_element/ui_screen/etc, a hook is one
  // concept shared by every file that registers or fires it.
  await pool.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'hook', 'hook:' || $3::text || ':' || h.name, h.name, 'parsed',
            jsonb_build_object('hook_id', 'hook:' || $3::text || ':' || h.name,
                                'name', h.name, 'framework', 'php')
       FROM (
         SELECT DISTINCT data->>'hook_name' AS name
           FROM entities
          WHERE project_id = $2 AND kind = 'hook_site' AND deleted_at IS NULL
       ) h
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET deleted_at = NULL, updated_at = now()`,
    [project.org_id, project.id, project.name]
  );

  // Tombstone `hook` entities no live hook_site references anymore.
  await pool.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'hook' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entities hs
           WHERE hs.project_id = $1 AND hs.kind = 'hook_site' AND hs.deleted_at IS NULL
             AND hs.data->>'hook_name' = entities.data->>'name'
        )`,
    [project.id]
  );

  // Recompute LISTENS_TO/FIRED_BY from scratch: delete every existing link
  // touching one of this project's `hook` entities, then reinsert below.
  await pool.query(
    `DELETE FROM entity_links el
       USING entities h
      WHERE el.relation IN ('LISTENS_TO', 'FIRED_BY')
        AND h.id IN (el.src_id, el.dst_id)
        AND h.project_id = $1 AND h.kind = 'hook'`,
    [project.id]
  );

  const firedRes = await pool.query(
    `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT DISTINCT $2::int, h.id, sym.entity_id, 'FIRED_BY'
       FROM entities hs
       JOIN entities h ON h.project_id = $1 AND h.kind = 'hook' AND h.deleted_at IS NULL
                      AND h.data->>'name' = hs.data->>'hook_name'
       JOIN files f ON f.project_id = $1 AND f.path = hs.data->>'source_path'
       JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL
                        AND sym.name = hs.data->>'owner'
      WHERE hs.project_id = $1 AND hs.kind = 'hook_site' AND hs.deleted_at IS NULL
        AND hs.data->>'direction' = 'fire'
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const listensRes = await pool.query(
    `WITH candidate AS (
       SELECT hs.id AS hook_site_id, h.id AS hook_id,
              min(sym.entity_id) AS symbol_entity_id, count(DISTINCT sym.entity_id) AS matches
         FROM entities hs
         JOIN entities h ON h.project_id = $1 AND h.kind = 'hook' AND h.deleted_at IS NULL
                        AND h.data->>'name' = hs.data->>'hook_name'
         JOIN symbols sym ON sym.project_id = $1 AND sym.entity_id IS NOT NULL
                          AND sym.name = hs.data->>'callback'
        WHERE hs.project_id = $1 AND hs.kind = 'hook_site' AND hs.deleted_at IS NULL
          AND hs.data->>'direction' = 'listen' AND hs.data->>'callback' IS NOT NULL
        GROUP BY hs.id, h.id
     )
     INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT $2::int, symbol_entity_id, hook_id, 'LISTENS_TO' FROM candidate WHERE matches = 1
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const hookCountRes = await pool.query(
    `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'hook' AND deleted_at IS NULL`,
    [project.id]
  );

  return {
    hookCount: hookCountRes.rows[0].n,
    firedBy: firedRes.rowCount ?? 0,
    listensTo: listensRes.rowCount ?? 0,
  };
}

/**
 * Project-wide WordPress shortcode graph resolution (Increment 1B, phase
 * 1B-1, REQ-023, AC-015).
 *
 * Runs once per index_project job (called from runIndex, not per file),
 * after this run's `symbols` table has settled -- same
 * position/gating/try-catch style as resolveHookGraph()/resolveI18nGraph()
 * above, reusing that pattern rather than inventing a second one
 * (contracts.md "Phase 1A-3"). Reads the project's live `shortcode_site`
 * staging entities (written per-file by writeUiShortcodeSites() above) and
 * derives:
 *
 *   - one generic `shortcode` entity per distinct tag a live shortcode_site
 *     references (upserted; tombstoned once no live shortcode_site
 *     references it anymore) -- WordPress itself allows only one callback
 *     per shortcode tag (a second add_shortcode() call for the same tag
 *     simply overwrites the first at runtime), so `shortcode` is one entity
 *     per tag, project-wide -- same "one shared concept, not per call site"
 *     treatment resolveHookGraph() already gives `hook` entities
 *     (contracts.md "Phase 1B-1").
 *   - REGISTERED_AT (shortcode -> registering symbol) and RENDERED_BY
 *     (shortcode -> callback symbol): BOTH matched within the call site's
 *     own file only -- unlike `hook`'s LISTENS_TO, this is deliberately NOT
 *     a project-wide symbol-name join. REQ-023's own text and AC-015's own
 *     worked example name no cross-file scenario (unlike EDGE-012, which
 *     explicitly drove LISTENS_TO's project-wide scope), and a shortcode's
 *     registration and its render callback are overwhelmingly declared in
 *     the same file in real WordPress plugin code. This mirrors
 *     resolveHookGraph()'s own FIRED_BY SQL shape (join through the call
 *     site's own file, then that file's own symbols), not its LISTENS_TO
 *     shape. When nothing matches in-file (the owner/callback name isn't a
 *     symbol in that same file, or `owner`/`callback` is the "@file"/null
 *     sentinel), no relation is written -- REQ-026/Q-018's no-fabrication
 *     rule, same as everywhere else in this feature.
 *
 * Recomputed in full on every run (delete existing REGISTERED_AT/
 * RENDERED_BY for this project's `shortcode` entities, then reinsert)
 * rather than diffed incrementally -- same cost/simplicity tradeoff
 * resolveHookGraph() already made and documented.
 */
async function resolveShortcodeGraph(project, log) {
  // Upsert a `shortcode` entity for every distinct tag a live
  // shortcode_site references. natural_key is keyed by tag alone
  // (project-wide), not by call site -- same convention as `hook`.
  await pool.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'shortcode', 'shortcode:' || $3::text || ':' || sc.tag, sc.tag, 'parsed',
            jsonb_build_object('shortcode_id', 'shortcode:' || $3::text || ':' || sc.tag,
                                'tag', sc.tag, 'framework', 'php')
       FROM (
         SELECT DISTINCT data->>'tag' AS tag
           FROM entities
          WHERE project_id = $2 AND kind = 'shortcode_site' AND deleted_at IS NULL
       ) sc
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET deleted_at = NULL, updated_at = now()`,
    [project.org_id, project.id, project.name]
  );

  // Tombstone `shortcode` entities no live shortcode_site references anymore.
  await pool.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'shortcode' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entities scs
           WHERE scs.project_id = $1 AND scs.kind = 'shortcode_site' AND scs.deleted_at IS NULL
             AND scs.data->>'tag' = entities.data->>'tag'
        )`,
    [project.id]
  );

  // Recompute REGISTERED_AT/RENDERED_BY from scratch: delete every existing
  // link touching one of this project's `shortcode` entities, then reinsert
  // below.
  await pool.query(
    `DELETE FROM entity_links el
       USING entities sc
      WHERE el.relation IN ('REGISTERED_AT', 'RENDERED_BY')
        AND sc.id = el.src_id
        AND sc.project_id = $1 AND sc.kind = 'shortcode'`,
    [project.id]
  );

  const registeredAtRes = await pool.query(
    `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT DISTINCT $2::int, sc.id, sym.entity_id, 'REGISTERED_AT'
       FROM entities scs
       JOIN entities sc ON sc.project_id = $1 AND sc.kind = 'shortcode' AND sc.deleted_at IS NULL
                       AND sc.data->>'tag' = scs.data->>'tag'
       JOIN files f ON f.project_id = $1 AND f.path = scs.data->>'source_path'
       JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL
                        AND sym.name = scs.data->>'owner'
      WHERE scs.project_id = $1 AND scs.kind = 'shortcode_site' AND scs.deleted_at IS NULL
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const renderedByRes = await pool.query(
    `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT DISTINCT $2::int, sc.id, sym.entity_id, 'RENDERED_BY'
       FROM entities scs
       JOIN entities sc ON sc.project_id = $1 AND sc.kind = 'shortcode' AND sc.deleted_at IS NULL
                       AND sc.data->>'tag' = scs.data->>'tag'
       JOIN files f ON f.project_id = $1 AND f.path = scs.data->>'source_path'
       JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL
                        AND sym.name = scs.data->>'callback'
      WHERE scs.project_id = $1 AND scs.kind = 'shortcode_site' AND scs.deleted_at IS NULL
        AND scs.data->>'callback' IS NOT NULL
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const shortcodeCountRes = await pool.query(
    `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'shortcode' AND deleted_at IS NULL`,
    [project.id]
  );

  return {
    shortcodeCount: shortcodeCountRes.rows[0].n,
    registeredAt: registeredAtRes.rowCount ?? 0,
    renderedBy: renderedByRes.rowCount ?? 0,
  };
}

/**
 * Project-wide Gutenberg static block-registration graph resolution
 * (Increment 1B, phase 1B-2, REQ-024, AC-016).
 *
 * Runs once per index_project job (called from runIndex, not per file),
 * right after resolveShortcodeGraph() -- same position/gating/try-catch
 * style, same reason (this join needs symbols.entity_id to be settled,
 * including anything the identity preflight backfilled earlier in this run
 * -- 1A-9's Bug #1 fix note). Reads the project's live `block_site` staging
 * entities (written per-file by writeUiBlockSites() above, which already
 * resolved and read each call site's block.json) and derives:
 *
 *   - one generic `block_manifest` entity per distinct block.json path a
 *     live block_site references (upserted; tombstoned once no live
 *     block_site references it anymore) -- the only way to give REQ-024's
 *     `DEFINED_IN` relation an actual `entities` row to target, since
 *     `entity_links.dst_id` is NOT NULL (schema constraint) and no relation
 *     in this codebase can point at a raw file path. Mirrors the existing
 *     `entities(kind='document')` precedent (src/migrations/0007_documents.sql)
 *     for "a specific file becomes an entity so relations can target it" --
 *     see contracts.md "Phase 1B-2" for the full reasoning. Generic naming
 *     (no `ui_` prefix), same non-UI-surface reasoning `document` itself
 *     already gets.
 *   - one generic `block` entity per distinct namespace (block.json's own
 *     `name` field) a live block_site references (upserted; tombstoned once
 *     no live block_site references it anymore) -- WordPress's own block
 *     registry is namespace-unique (one canonical registration), the same
 *     "one shared concept, not per call site" shape resolveHookGraph()/
 *     resolveShortcodeGraph() already give `hook`/`shortcode`.
 *   - `DEFINED_IN` (block -> block_manifest): only when a namespace maps to
 *     exactly one distinct block.json path across every live block_site
 *     referencing it -- "only unique matches are linked", same discipline
 *     resolveHookGraph()'s LISTENS_TO already applies (REQ-026/Q-018).
 *   - `RENDERED_BY` (block -> render-callback symbol): matched **same-file
 *     only**, mirroring resolveShortcodeGraph()'s own RENDERED_BY SQL shape
 *     exactly (join through the call site's own file, then that file's own
 *     symbols) -- not `hook`'s project-wide LISTENS_TO shape. REQ-024's own
 *     text and AC-016's own worked example name no cross-file scenario, and
 *     a block's registration call and its render callback are
 *     overwhelmingly declared in the same file in real WordPress code, same
 *     reasoning 1B-1 already applied to `shortcode`'s own RENDERED_BY.
 *
 * Deliberately does NOT create any entity for a *persisted* block instance
 * (markup in `wp_posts.post_content`) -- REQ-024/EDGE-014 scope that to
 * Increment 3, and this indexer has no access to WordPress's database at
 * all, only static source files, so a persisted `<!-- wp:button -->`
 * instance is structurally unreachable from any code path in this feature.
 * `resolution_status: "data_owned"` (reserved for this phase by 1A-6's own
 * contracts.md note) is therefore never written anywhere by this phase --
 * see contracts.md "Phase 1B-2" for the AC-017 verification this reasoning
 * is checked against.
 *
 * Recomputed in full on every run (delete existing DEFINED_IN/RENDERED_BY
 * for this project's `block` entities, then reinsert) -- same
 * cost/simplicity tradeoff resolveHookGraph()/resolveShortcodeGraph()
 * already made and documented.
 */
async function resolveBlockGraph(project, log) {
  // Upsert a `block_manifest` entity for every distinct block.json path a
  // live block_site references. natural_key is keyed by path alone
  // (project-wide), same convention as `document`'s own path-keyed identity.
  await pool.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'block_manifest', 'block_manifest:' || $3::text || ':' || bm.path, bm.path, 'parsed',
            jsonb_build_object('block_manifest_id', 'block_manifest:' || $3::text || ':' || bm.path,
                                'path', bm.path, 'framework', 'php')
       FROM (
         SELECT DISTINCT data->>'block_json_path' AS path
           FROM entities
          WHERE project_id = $2 AND kind = 'block_site' AND deleted_at IS NULL
       ) bm
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET deleted_at = NULL, updated_at = now()`,
    [project.org_id, project.id, project.name]
  );

  // Tombstone `block_manifest` entities no live block_site references anymore.
  await pool.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'block_manifest' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entities bs
           WHERE bs.project_id = $1 AND bs.kind = 'block_site' AND bs.deleted_at IS NULL
             AND bs.data->>'block_json_path' = entities.data->>'path'
        )`,
    [project.id]
  );

  // Upsert a `block` entity for every distinct namespace a live block_site
  // references. natural_key is keyed by namespace alone (project-wide), not
  // by call site -- same convention as `hook`/`shortcode`. Title/category/
  // textdomain are carried through as convenience data from one arbitrary
  // contributing block_site (DISTINCT ON, deterministic but arbitrary
  // tiebreak by id) -- a documented limitation if the same namespace is ever
  // (unusually) declared by more than one distinct block.json with
  // different metadata; the namespace identity itself is never ambiguous.
  await pool.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'block', 'block:' || $3::text || ':' || b.namespace, COALESCE(b.title, b.namespace), 'parsed',
            jsonb_build_object('block_id', 'block:' || $3::text || ':' || b.namespace,
                                'namespace', b.namespace, 'title', b.title, 'category', b.category,
                                'textdomain', b.textdomain, 'framework', 'php')
       FROM (
         SELECT DISTINCT ON (data->>'namespace')
                data->>'namespace' AS namespace, data->>'title' AS title,
                data->>'category' AS category, data->>'textdomain' AS textdomain
           FROM entities
          WHERE project_id = $2 AND kind = 'block_site' AND deleted_at IS NULL
          ORDER BY data->>'namespace', id DESC
       ) b
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = entities.data || EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, project.name]
  );

  // Tombstone `block` entities no live block_site references anymore.
  await pool.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'block' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entities bs
           WHERE bs.project_id = $1 AND bs.kind = 'block_site' AND bs.deleted_at IS NULL
             AND bs.data->>'namespace' = entities.data->>'namespace'
        )`,
    [project.id]
  );

  // Recompute DEFINED_IN/RENDERED_BY from scratch: delete every existing
  // link touching one of this project's `block` entities, then reinsert
  // below.
  await pool.query(
    `DELETE FROM entity_links el
       USING entities blk
      WHERE el.relation IN ('DEFINED_IN', 'RENDERED_BY')
        AND blk.id = el.src_id
        AND blk.project_id = $1 AND blk.kind = 'block'`,
    [project.id]
  );

  const definedInRes = await pool.query(
    `WITH pairs AS (
       SELECT DISTINCT data->>'namespace' AS namespace, data->>'block_json_path' AS path
         FROM entities
        WHERE project_id = $1 AND kind = 'block_site' AND deleted_at IS NULL
     ), unique_pairs AS (
       SELECT namespace, min(path) AS path FROM pairs GROUP BY namespace HAVING count(*) = 1
     )
     INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT DISTINCT $2::int, blk.id, bm.id, 'DEFINED_IN'
       FROM unique_pairs up
       JOIN entities blk ON blk.project_id = $1 AND blk.kind = 'block' AND blk.deleted_at IS NULL
                         AND blk.data->>'namespace' = up.namespace
       JOIN entities bm  ON bm.project_id = $1 AND bm.kind = 'block_manifest' AND bm.deleted_at IS NULL
                         AND bm.data->>'path' = up.path
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const renderedByRes = await pool.query(
    `WITH sites AS (
       SELECT DISTINCT data->>'namespace' AS namespace, data->>'source_path' AS source_path,
              data->>'render_callback' AS render_callback
         FROM entities
        WHERE project_id = $1 AND kind = 'block_site' AND deleted_at IS NULL
          AND data->>'render_callback' IS NOT NULL
     )
     INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT DISTINCT $2::int, blk.id, sym.entity_id, 'RENDERED_BY'
       FROM sites s
       JOIN entities blk ON blk.project_id = $1 AND blk.kind = 'block' AND blk.deleted_at IS NULL
                         AND blk.data->>'namespace' = s.namespace
       JOIN files f ON f.project_id = $1 AND f.path = s.source_path
       JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL
                        AND sym.name = s.render_callback
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [project.id, project.org_id]
  );

  const blockCountRes = await pool.query(
    `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'block' AND deleted_at IS NULL`,
    [project.id]
  );

  return {
    blockCount: blockCountRes.rows[0].n,
    definedIn: definedInRes.rowCount ?? 0,
    renderedBy: renderedByRes.rowCount ?? 0,
  };
}

/**
 * Project-wide WordPress gettext i18n resolution (Increment 1A, phase 1A-4,
 * REQ-003/REQ-004, EDGE-004/EDGE-005).
 *
 * Runs once per index_project job, right after resolveHookGraph() -- same
 * position/gating/try-catch style, reusing that pattern rather than
 * inventing a second one (contracts.md "Phase 1A-3"). Reads the project's
 * live `i18n_call_site` staging entities (written per-file by
 * writeUiI18nCallSites() above) plus the project's `.po`/`.mo` catalogs
 * (discovered fresh from disk on every call -- src/ui/i18nCatalog.js holds
 * no module-level cache, so two `index_project` runs for two different
 * projects never share catalog state), and derives:
 *
 *   - one generic `i18n_key` entity per distinct (textdomain, msgctxt,
 *     msgid) triple a live i18n_call_site references (upserted; tombstoned
 *     once no live call site references it anymore) -- same "one shared
 *     concept, not per call site" treatment resolveHookGraph() already
 *     gives `hook` entities.
 *   - TRANSLATION_USED_AT (i18n_key -> usage-site symbol): matched
 *     same-file only (Q-003-bounded, same discipline as every other
 *     in-file resolution in this feature) -- the "usage site" corner of
 *     REQ-004's three query entry points, present even for a key that
 *     backs no `ui_element` at all (a CLI message, an email, an API error
 *     -- REQ-004's own framing for why `i18n_key` is generic).
 *   - TRANSLATION_OF (ui_element -> i18n_key): only for a `ui_element` row
 *     whose `data.i18n_key` (staged by 1A-1/1A-2) uniquely matches one
 *     `i18n_key` entity by (source_path, owner, msgid). Ambiguous matches
 *     (two different call-site domains sharing the same source_path/owner/
 *     msgid) are left unlinked -- no fabrication, same discipline as
 *     LISTENS_TO's "only unique matches" rule.
 *   - updates that same `ui_element`'s `data.text`/`data.text_source` per
 *     REQ-011's precedence, but ONLY when `data.text === data.i18n_key`
 *     exactly (the "pure i18n" case -- the entire literal fragment/argument
 *     WAS the i18n wrapper call, the dominant real-world idiom and always
 *     true for `submit_button()`). A compound literal that mixes real
 *     literal text with an i18n call (`'Save ' . __('now','td') . '!'`) is
 *     left exactly as 1A-1 reconstructed it -- this phase does not attempt
 *     substring splicing on an already-approximate probe string. Documented
 *     limitation, not a silent guess.
 *
 * Textdomain resolution: a call site's own literal `$domain` (or WP's own
 * documented `'default'` when the argument was omitted -- same reasoning
 * 1A-2 applied to submit_button()'s omitted args) is used as-is; if that
 * domain has no discovered catalogs at all, the key is still indexed with
 * an empty `translations` map (EDGE-004: "normal, non-error state"), and no
 * OTHER domain's catalog is borrowed -- guessing a different domain for a
 * call site whose own domain IS known would misattribute the string. The
 * unique-cross-domain fallback (resolveKeyAnyDomain) is used ONLY when the
 * call site's own `$domain` argument could not be resolved at all (a
 * variable, a constant) -- and only when exactly one discovered textdomain
 * has this msgid; more than one is left unresolved rather than guessed.
 *
 * Recomputed in full on every run (delete existing TRANSLATION_OF/
 * TRANSLATION_USED_AT for this project's i18n_key entities, then reinsert)
 * -- same cost/simplicity tradeoff resolveHookGraph() already made and
 * documented (contracts.md "Phase 1A-3").
 */
async function resolveI18nGraph(project, root, log) {
  const catalogs = discoverCatalogs(root);
  for (const w of catalogs.warnings) log(`i18n catalog: ${w}`);

  const siteRes = await pool.query(
    `SELECT data FROM entities
      WHERE project_id = $1 AND kind = 'i18n_call_site' AND deleted_at IS NULL`,
    [project.id]
  );

  // Group into distinct (domain, msgctxt, msgid) triples -- this is the
  // i18n_key identity (project-wide, like `hook`, not per call site).
  const tripleKeyOf = (domain, msgctxt, msgid) =>
    `${domain ?? " "}${msgctxt ?? " "}${msgid}`;
  const triples = new Map();
  for (const row of siteRes.rows) {
    const d = row.data;
    const tk = tripleKeyOf(d.domain, d.msgctxt, d.msgid);
    if (!triples.has(tk)) triples.set(tk, { domain: d.domain, msgctxt: d.msgctxt, msgid: d.msgid, sites: [] });
    triples.get(tk).sites.push({ owner: d.owner, source_path: d.source_path });
  }

  if (!triples.size) {
    await pool.query(
      `UPDATE entities SET deleted_at = now(), updated_at = now()
        WHERE project_id = $1 AND kind = 'i18n_key' AND deleted_at IS NULL`,
      [project.id]
    );
    await pool.query(
      `DELETE FROM entity_links el USING entities k
        WHERE el.relation IN ('TRANSLATION_OF', 'TRANSLATION_USED_AT')
          AND k.id IN (el.src_id, el.dst_id) AND k.project_id = $1 AND k.kind = 'i18n_key'`,
      [project.id]
    );
    return { keyCount: 0, translationOf: 0, usedAt: 0 };
  }

  const preferredLocale = config.uiI18nLocale;

  const keys = [], titles = [], datas = [];
  const resolvedTextByKey = new Map(); // entityKey -> resolvedText|null
  const triplesByKey = new Map(); // entityKey -> the triple record (sites, msgid)
  for (const [tk, t] of triples) {
    let res = null;
    let resolvedDomain = t.domain;
    if (t.domain) {
      // Domain is known -- resolve against that domain's own catalogs only.
      // No other domain's catalog is ever borrowed (see doc comment above).
      res = resolveKey(catalogs, t.domain, t.msgctxt, t.msgid, preferredLocale);
    } else {
      // Domain unknown (a dynamic $domain argument) -- the unique
      // cross-domain fallback is the only case this phase attempts
      // cross-domain matching at all.
      const anyRes = resolveKeyAnyDomain(catalogs, t.msgctxt, t.msgid, preferredLocale);
      if (anyRes) { res = anyRes; resolvedDomain = anyRes.domain; }
    }

    const translations = res?.translations ?? {};
    const resolvedLocale = res?.resolvedLocale ?? null;
    const resolvedText = res?.resolvedText ?? null;
    const catalogSource = res?.catalogSource ?? [];

    const domainForKey = resolvedDomain ?? "unknown";
    const fp = sha256(`${t.msgctxt ?? ""}|${t.msgid}`).slice(0, 12);
    const entityKey = `i18n:${project.name}:${domainForKey}:${fp}`;
    keys.push(entityKey);
    titles.push(t.msgid);
    datas.push(JSON.stringify({
      i18n_key_id: entityKey, framework: "php",
      textdomain: domainForKey, msgid: t.msgid, msgctxt: t.msgctxt ?? null,
      translations, resolved_locale: resolvedLocale, resolved_text: resolvedText,
      catalog_source: catalogSource,
    }));
    resolvedTextByKey.set(entityKey, resolvedText);
    triplesByKey.set(entityKey, t);
  }

  const idRes = await pool.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'i18n_key', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()
     RETURNING id, natural_key`,
    [project.org_id, project.id, keys, titles, datas]
  );
  const idByKey = new Map(idRes.rows.map((r) => [r.natural_key, r.id]));

  // Tombstone i18n_key entities no live triple references anymore.
  await pool.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'i18n_key' AND deleted_at IS NULL
        AND natural_key <> ALL($2::text[])`,
    [project.id, keys]
  );

  // Recompute TRANSLATION_OF/TRANSLATION_USED_AT from scratch.
  await pool.query(
    `DELETE FROM entity_links el
       USING entities k
      WHERE el.relation IN ('TRANSLATION_OF', 'TRANSLATION_USED_AT')
        AND k.id IN (el.src_id, el.dst_id)
        AND k.project_id = $1 AND k.kind = 'i18n_key'`,
    [project.id]
  );

  // TRANSLATION_USED_AT: i18n_key -> usage-site symbol, in-file only.
  // "@file" (no enclosing symbol) is skipped -- nothing to link, no
  // fabrication.
  const usedPairs = [];
  const seenUsedPair = new Set();
  for (const [entityKey, t] of triplesByKey) {
    const entityId = idByKey.get(entityKey);
    if (!entityId) continue;
    for (const s of t.sites) {
      if (s.owner === "@file") continue;
      const pk = `${entityId}|${s.source_path}|${s.owner}`;
      if (seenUsedPair.has(pk)) continue;
      seenUsedPair.add(pk);
      usedPairs.push({ entityId, sourcePath: s.source_path, owner: s.owner });
    }
  }
  let usedAt = 0;
  if (usedPairs.length) {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
       SELECT DISTINCT $1::int, u.entity_id, sym.entity_id, 'TRANSLATION_USED_AT'
         FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(entity_id, source_path, owner)
         JOIN files f ON f.project_id = $5 AND f.path = u.source_path
         JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL AND sym.name = u.owner
       ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
      [
        project.org_id,
        usedPairs.map((p) => p.entityId),
        usedPairs.map((p) => p.sourcePath),
        usedPairs.map((p) => p.owner),
        project.id,
      ]
    );
    usedAt = r.rowCount ?? 0;
  }

  // TRANSLATION_OF: ui_element -> i18n_key, matched by (source_path, owner,
  // msgid) against 1A-1/1A-2's staged data.i18n_key. Also updates
  // text/text_source when the element's whole resolved text IS the i18n key
  // (see doc comment above for the compound-literal limitation).
  const usageLookup = new Map(); // "path|owner|msgid" -> Set<entityKey>
  for (const [entityKey, t] of triplesByKey) {
    for (const s of t.sites) {
      const lk = `${s.source_path}|${s.owner}|${t.msgid}`;
      if (!usageLookup.has(lk)) usageLookup.set(lk, new Set());
      usageLookup.get(lk).add(entityKey);
    }
  }

  const elRes = await pool.query(
    `SELECT id, data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND deleted_at IS NULL
        AND data->>'i18n_key' IS NOT NULL`,
    [project.id]
  );

  const translationOfSrc = [], translationOfDst = [];
  const textUpdateIds = [], textUpdateTextJson = [], textUpdateSource = [];
  for (const row of elRes.rows) {
    const d = row.data;
    const lk = `${d.source_path}|${d.owner}|${d.i18n_key}`;
    const matchSet = usageLookup.get(lk);
    if (!matchSet || matchSet.size !== 1) continue; // no match, or ambiguous -- skip, no fabrication
    const entityKey = [...matchSet][0];
    const entityId = idByKey.get(entityKey);
    if (!entityId) continue;
    translationOfSrc.push(row.id);
    translationOfDst.push(entityId);

    if (d.text === d.i18n_key) {
      const resolvedText = resolvedTextByKey.get(entityKey) ?? null;
      textUpdateIds.push(row.id);
      textUpdateTextJson.push(JSON.stringify(resolvedText)); // "null" or a JSON string literal
      textUpdateSource.push(resolvedText !== null ? "translated_catalog_value" : "translation_key");
    }
  }

  let translationOf = 0;
  if (translationOfSrc.length) {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
       SELECT $1::int, s, d, 'TRANSLATION_OF' FROM unnest($2::bigint[], $3::bigint[]) AS u(s, d)
       ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
      [project.org_id, translationOfSrc, translationOfDst]
    );
    translationOf = r.rowCount ?? 0;
  }

  if (textUpdateIds.length) {
    await pool.query(
      `UPDATE entities e
          SET data = jsonb_set(jsonb_set(e.data, '{text}', u.text_val::jsonb, true), '{text_source}', to_jsonb(u.source_val), true),
              updated_at = now()
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS u(id, text_val, source_val)
        WHERE e.id = u.id`,
      [textUpdateIds, textUpdateTextJson, textUpdateSource]
    );
  }

  return { keyCount: keys.length, translationOf, usedAt };
}

/**
 * Persist one PHP file's `do_settings_sections($page)` call sites
 * (Increment 1A, phase 1A-6, REQ-018 completion) as `settings_render_site`
 * staging entities -- one row per call found by
 * src/ui/phpSettingsRender.js.
 *
 * `settings_render_site` is an internal-only entity kind, same status as
 * `hook_site`/`i18n_call_site` (contracts.md "Phase 1A-3"/"Phase 1A-6"):
 * never returned by any MCP operation, not part of REQ-025's fixed
 * `entities.kind` list. It exists purely so resolveUiRelations()'s
 * project-wide post-pass can complete the cross-file section/field ->
 * render-site correlation that 1A-2 only ever resolved same-file (see
 * contracts.md "Phase 1A-6" for the reasoning).
 *
 * Same tombstone-then-upsert lifecycle as writeUiHookSites()/
 * writeUiI18nCallSites().
 */
async function writeUiSettingsRenderSites(client, project, rel, sites) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'settings_render_site'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!sites.length) return;

  const seen = new Map();
  const keys = [];
  const titles = [];
  const datas = [];
  for (const s of sites) {
    const sig = sha256(`${s.page}|${s.owner}|${s.line}`).slice(0, 12);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    const fingerprint = n > 1 ? `${sig}-${n}` : sig;
    keys.push(`settingsrender:${project.name}:php:${rel}:${s.owner}:${fingerprint}`);
    titles.push(s.page);
    datas.push(JSON.stringify({ source_path: rel, owner: s.owner, line: s.line, page: s.page }));
  }

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'settings_render_site', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

/**
 * Persist one PHP file's `add_shortcode(tag, callback)` call sites
 * (Increment 1B, phase 1B-1, REQ-023) as `shortcode_site` staging entities
 * -- one row per call site found in this file by src/ui/phpShortcodes.js.
 *
 * `shortcode_site` is an internal-only entity kind, same status as
 * `hook_site`/`i18n_call_site`/`settings_render_site`: never returned by any
 * MCP operation, not part of REQ-025's fixed `entities.kind` list. It exists
 * purely so resolveShortcodeGraph()'s project-wide post-pass can see every
 * file's shortcode registration call sites without re-parsing PHP source on
 * every index_project run -- a `shortcode` entity is keyed by tag alone,
 * project-wide (same precedent as `hook`, contracts.md "Phase 1A-3"), so its
 * own upsert/tombstone lifecycle needs to see every file's live call sites
 * at once, not just this one file's.
 *
 * Same tombstone-then-upsert lifecycle as writeUiHookSites()/
 * writeUiI18nCallSites()/writeUiSettingsRenderSites().
 */
async function writeUiShortcodeSites(client, project, rel, shortcodes) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'shortcode_site'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!shortcodes.length) return;

  const seen = new Map(); // content fingerprint -> count, disambiguates identical siblings under one owner
  const keys = [];
  const titles = [];
  const datas = [];
  for (const s of shortcodes) {
    const sig = sha256(`${s.tag}|${s.callback ?? ""}|${s.owner}|${s.line}`).slice(0, 12);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    const fingerprint = n > 1 ? `${sig}-${n}` : sig;
    keys.push(`shortcodesite:${project.name}:php:${rel}:${s.owner}:${fingerprint}`);
    titles.push(s.tag);
    datas.push(JSON.stringify({ source_path: rel, owner: s.owner, line: s.line, tag: s.tag, callback: s.callback }));
  }

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'shortcode_site', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

/**
 * Persist one PHP file's `register_block_type()` call sites (Increment 1B,
 * phase 1B-2, REQ-024) as `block_site` staging entities -- one row per call
 * site found in this file by src/ui/phpBlocks.js, but only for a call site
 * whose block.json actually resolves.
 *
 * `block_site` is an internal-only entity kind, same status as
 * `hook_site`/`i18n_call_site`/`settings_render_site`/`shortcode_site`:
 * never returned by any MCP operation, not part of REQ-025's fixed
 * `entities.kind` list. It exists purely so resolveBlockGraph()'s
 * project-wide post-pass can see every file's block registration call sites
 * without re-parsing PHP source (or re-reading every block.json) on every
 * index_project run -- a `block` entity is keyed by namespace alone,
 * project-wide (same precedent as `hook`/`shortcode`, contracts.md "Phase
 * 1A-3"/"Phase 1B-1"), so its own upsert/tombstone lifecycle needs to see
 * every file's live call sites at once, not just this one file's.
 *
 * This is the one write path in the whole UI Intelligence feature that
 * turns a resolved *source-text* fragment into a read of a *second* file --
 * phpBlocks.js only ever resolves `dirArg` down to a literal path fragment
 * relative to this file's own directory (Q-003-bounded, syntax-only); this
 * function is what joins that fragment onto `rel`'s own directory, computes
 * the candidate block.json path, and hands it to
 * src/ui/blockManifest.js#readBlockManifest(). A call site whose resolved
 * path escapes the project root (see the root-boundary check below), or
 * whose block.json is missing/unparseable/has no `name` field, is skipped
 * entirely -- no `block_site` row, no downstream `block` entity -- same
 * no-fabrication rule as every other unresolvable input in this feature
 * (REQ-026/Q-018).
 *
 * Same tombstone-then-upsert lifecycle as writeUiHookSites()/
 * writeUiI18nCallSites()/writeUiSettingsRenderSites()/writeUiShortcodeSites().
 */
async function writeUiBlockSites(client, project, root, rel, blocks) {
  await client.query(
    `UPDATE entities SET deleted_at = now(), updated_at = now()
      WHERE project_id = $1 AND kind = 'block_site'
        AND data->>'source_path' = $2 AND deleted_at IS NULL`,
    [project.id, rel]
  );
  if (!blocks.length) return;

  const fileDir = path.posix.dirname(rel);
  const seen = new Map(); // content fingerprint -> count, disambiguates identical siblings under one owner
  const keys = [];
  const titles = [];
  const datas = [];
  for (const b of blocks) {
    // b.dirArg is relative to this file's own directory (phpBlocks.js's own
    // contract) -- join it on, then either treat it as the block.json path
    // directly (the call site already named the file, e.g.
    // `__DIR__ . '/build/block.json'`) or append the conventional filename.
    const joined = path.posix.normalize(path.posix.join(fileDir, b.dirArg));
    const blockJsonRel = joined.endsWith(".json") ? joined : path.posix.join(joined, "block.json");
    const normalizedRel = path.posix.normalize(blockJsonRel);

    // Root-boundary check (Gate note, contracts.md "Phase 1B-2"): a crafted
    // dirArg (e.g. repeated "../") could otherwise walk the resolved path
    // outside the project root, turning parsed source text into an
    // arbitrary local file read. Refuse rather than follow it.
    if (normalizedRel === ".." || normalizedRel.startsWith("../")) continue;

    const manifest = readBlockManifest(path.join(root, normalizedRel));
    if (!manifest) continue; // no resolvable block.json/namespace -> no entity

    const sig = sha256(
      `${manifest.name}|${normalizedRel}|${b.renderCallback ?? ""}|${b.owner}|${b.line}`
    ).slice(0, 12);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    const fingerprint = n > 1 ? `${sig}-${n}` : sig;
    keys.push(`blocksite:${project.name}:php:${rel}:${b.owner}:${fingerprint}`);
    titles.push(manifest.name);
    datas.push(JSON.stringify({
      source_path: rel, owner: b.owner, line: b.line,
      namespace: manifest.name, title: manifest.title, category: manifest.category,
      textdomain: manifest.textdomain,
      block_json_path: normalizedRel,
      render_callback: b.renderCallback,
    }));
  }
  if (!keys.length) return;

  await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     SELECT $1, $2, 'block_site', u.k, u.title, 'parsed', u.data::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, title, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title      = EXCLUDED.title,
            data       = EXCLUDED.data,
            deleted_at = NULL,
            updated_at = now()`,
    [project.org_id, project.id, keys, titles, datas]
  );
}

// Path-based ownership classification (REQ-013): a resolved source location
// is "framework" when it sits under wp-admin/, wp-includes/, or vendor/ --
// contracts.md "Fixed by the spec"'s heuristic, expressed once as SQL so
// every UPDATE/INSERT below can reuse it instead of re-deriving it in JS
// per row. `%1$s` is substituted with the column/expression holding the
// path (always `data->>'source_path'` in this file, but kept as a template
// so a future caller classifying a different column doesn't have to
// duplicate the pattern).
const OWNERSHIP_CASE_SQL = (pathExpr) => `
  CASE WHEN ${pathExpr} ~ '(^|/)(wp-admin|wp-includes|vendor)/' THEN 'framework'
       ELSE 'application' END`;

/**
 * Project-wide UI relation post-pass (Increment 1A, phase 1A-6 -- THE
 * checkpoint phase). Runs once per index_project job, after the identity
 * preflight (1A-5) has settled -- see contracts.md "Phase 1A-6" for the
 * full pipeline-position verification and the design decisions summarized
 * below.
 *
 * Builds:
 *   - `ui_component` entities (REQ-019/REQ-020's new node type; materialized
 *     one per distinct (source_path, owner) pair referenced by a live
 *     ui_element/ui_screen/ui_settings_section/ui_settings_field, excluding
 *     the "@file" top-level sentinel).
 *   - `RENDERS` (ui_component -> ui_element).
 *   - `DEFINED_BY` (ui_element/ui_component -> the owning symbol's entity,
 *     in-file only -- an owner is always in-file by construction). When
 *     `identityPreflight?.complete !== true`, a miss is recorded as
 *     `resolution_status: "unresolved"` on the entity itself (never as a
 *     relation row -- entity_links.dst_id is NOT NULL, there is nothing to
 *     point a link at); when identity IS complete, a miss means
 *     `"unknown_render"` (genuinely no candidate symbol).
 *   - `HANDLED_BY` (ui_component -> symbol): reuses 1A-3's already-resolved
 *     LISTENS_TO graph -- a component that FIRES a hook some other project
 *     symbol LISTENS_TO is "handled by" that symbol. No hook logic is
 *     reimplemented here.
 *   - `CONTAINS` (ui_screen -> ui_component, via the shared DEFINED_BY/
 *     RENDERED_BY target symbol entity_id; ui_component -> ui_settings_
 *     section/field and ui_screen -> ui_settings_section/field, via the new
 *     settings_render_site staging entity completing 1A-2's same-file-only
 *     do_settings_sections() correlation cross-file; ui_settings_section ->
 *     ui_settings_field via (page, section) matching).
 *   - `RENDERED_ON` (ui_element -> ui_screen, flattened from ui_screen
 *     CONTAINS ui_component RENDERS ui_element, for direct screen-scoped
 *     querying -- REQ-006). Same miss semantics as DEFINED_BY
 *     (unresolved/unknown_render), and EDGE-006 is resolved as "one entity,
 *     many RENDERED_ON links" (contracts.md "Phase 1A-6").
 *   - `ownership` classification (REQ-013) merged into every live
 *     ui_element/ui_screen/ui_component/ui_settings_section/
 *     ui_settings_field's own `data`, and into every DEFINED_BY/HANDLED_BY
 *     link's `data` (classifying the *target* symbol's file).
 *
 * Recomputed in full on every run (delete this project's own DEFINED_BY/
 * HANDLED_BY/CONTAINS/RENDERS/RENDERED_ON links touching a ui_* entity,
 * then reinsert), same cost/simplicity tradeoff resolveHookGraph()/
 * resolveI18nGraph() already made and documented -- ui_component entities
 * are tombstoned the same "no longer referenced" way `hook`/`i18n_key` are,
 * not tied to any one file's per-file tombstone pass.
 *
 * Each step below is independently try/catch-wrapped (REQ-021): one
 * relation-resolution step throwing must not take down the others or the
 * overall index, matching the existing convention at
 * src/indexer.js:457-492 / :616-627.
 */
async function resolveUiRelations(project, identityPreflight, log) {
  const identityComplete = identityPreflight?.complete === true;
  const missStatus = identityComplete ? "unknown_render" : "unresolved";
  const UI_KINDS = ["ui_element", "ui_screen", "ui_component", "ui_settings_section", "ui_settings_field"];
  const stats = { componentCount: 0, definedBy: 0, handledBy: 0, contains: 0, renders: 0, renderedOn: 0, errors: [] };

  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      log(`UI relation post-pass step "${name}" skipped: ${e.message}`);
      stats.errors.push({ step: name, error: e.message });
    }
  };

  // Recompute in full: clear every relation this phase owns, touching this
  // project's ui_* entities, before reinserting below.
  await step("clear-stale-links", async () => {
    await pool.query(
      `DELETE FROM entity_links el
         USING entities e
        WHERE el.relation IN ('DEFINED_BY', 'HANDLED_BY', 'CONTAINS', 'RENDERS', 'RENDERED_ON')
          AND e.id IN (el.src_id, el.dst_id)
          AND e.project_id = $1 AND e.kind = ANY($2::text[])`,
      [project.id, UI_KINDS]
    );
  });

  // ui_component materialization: one per (source_path, owner) referenced
  // by a live element/screen/settings row, excluding "@file".
  await step("materialize-ui-component", async () => {
    await pool.query(
      `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
       SELECT $1, $2, 'ui_component',
              'ui:' || $3::text || ':php:' || o.source_path || ':' || o.owner || ':component',
              o.owner, 'parsed',
              jsonb_build_object(
                'component_id', 'ui:' || $3::text || ':php:' || o.source_path || ':' || o.owner || ':component',
                'framework', 'php', 'source_path', o.source_path, 'owner', o.owner,
                'ownership', ${OWNERSHIP_CASE_SQL("o.source_path")}
              )
         FROM (
           SELECT DISTINCT data->>'source_path' AS source_path, data->>'owner' AS owner
             FROM entities
            WHERE project_id = $2 AND deleted_at IS NULL
              AND kind IN ('ui_element', 'ui_screen', 'ui_settings_section', 'ui_settings_field')
              AND data->>'owner' IS NOT NULL AND data->>'owner' <> '@file'
         ) o
       ON CONFLICT (project_id, kind, natural_key) DO UPDATE
          SET data = entities.data || EXCLUDED.data, deleted_at = NULL, updated_at = now()`,
      [project.org_id, project.id, project.name]
    );
    // Tombstone components no live element/screen/settings row references anymore.
    await pool.query(
      `UPDATE entities SET deleted_at = now(), updated_at = now()
        WHERE project_id = $1 AND kind = 'ui_component' AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM entities o
             WHERE o.project_id = $1 AND o.deleted_at IS NULL
               AND o.kind IN ('ui_element', 'ui_screen', 'ui_settings_section', 'ui_settings_field')
               AND o.data->>'source_path' = entities.data->>'source_path'
               AND o.data->>'owner' = entities.data->>'owner'
          )`,
      [project.id]
    );
    const c = await pool.query(
      `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'ui_component' AND deleted_at IS NULL`,
      [project.id]
    );
    stats.componentCount = c.rows[0].n;
  });

  // Ownership classification (REQ-013), merged into every live ui_element/
  // ui_screen/ui_settings_section/ui_settings_field's own data (ui_component
  // already got it inline above).
  await step("classify-ownership", async () => {
    await pool.query(
      `UPDATE entities
          SET data = data || jsonb_build_object('ownership', ${OWNERSHIP_CASE_SQL("data->>'source_path'")}),
              updated_at = now()
        WHERE project_id = $1 AND deleted_at IS NULL
          AND kind IN ('ui_element', 'ui_screen', 'ui_settings_section', 'ui_settings_field')`,
      [project.id]
    );
  });

  // RENDERS (ui_component -> ui_element): same (source_path, owner).
  await step("renders", async () => {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
       SELECT DISTINCT $2::int, c.id, el.id, 'RENDERS', '{"resolution_status":"resolved"}'::jsonb
         FROM entities c
         JOIN entities el ON el.project_id = $1 AND el.kind = 'ui_element' AND el.deleted_at IS NULL
                          AND el.data->>'source_path' = c.data->>'source_path'
                          AND el.data->>'owner' = c.data->>'owner'
        WHERE c.project_id = $1 AND c.kind = 'ui_component' AND c.deleted_at IS NULL
       ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
      [project.id, project.org_id]
    );
    stats.renders = r.rowCount ?? 0;
  });

  // DEFINED_BY (ui_element/ui_component -> owning symbol's entity), in-file
  // only. Miss handling (unresolved vs unknown_render) applied per kind below.
  await step("defined-by", async () => {
    let n = 0;
    for (const kind of ["ui_element", "ui_component"]) {
      const r = await pool.query(
        `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
         SELECT $2::int, e.id, sym.entity_id, 'DEFINED_BY',
                jsonb_build_object('resolution_status', 'resolved',
                                    'ownership', ${OWNERSHIP_CASE_SQL("f.path")})
           FROM entities e
           JOIN files f ON f.project_id = $1 AND f.path = e.data->>'source_path'
           JOIN symbols sym ON sym.file_id = f.id AND sym.entity_id IS NOT NULL
                            AND sym.name = e.data->>'owner'
          WHERE e.project_id = $1 AND e.kind = $3 AND e.deleted_at IS NULL
            AND e.data->>'owner' IS NOT NULL AND e.data->>'owner' <> '@file'
         ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
        [project.id, project.org_id, kind]
      );
      n += r.rowCount ?? 0;

      // Per-relation status field: `defined_by_status`, deliberately NOT the
      // shared `resolution_status` name -- an entity can independently miss
      // DEFINED_BY and RENDERED_ON (below) for different reasons, and a
      // single shared key would have the later step's write clobber the
      // earlier one's. Misses:
      await pool.query(
        `UPDATE entities e
            SET data = data || jsonb_build_object('defined_by_status', $3::text), updated_at = now()
          WHERE e.project_id = $1 AND e.kind = $2 AND e.deleted_at IS NULL
            AND e.data->>'owner' IS NOT NULL AND e.data->>'owner' <> '@file'
            AND NOT EXISTS (
              SELECT 1 FROM entity_links el WHERE el.src_id = e.id AND el.relation = 'DEFINED_BY'
            )`,
        [project.id, kind, missStatus]
      );
      // Anything that DID resolve this run must have a stale prior miss
      // note cleared (identity can go from incomplete -> complete between
      // runs; this recompute-in-full pass is what upgrades it).
      await pool.query(
        `UPDATE entities e
            SET data = data || '{"defined_by_status":"resolved"}'::jsonb, updated_at = now()
          WHERE e.project_id = $1 AND e.kind = $2 AND e.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM entity_links el WHERE el.src_id = e.id AND el.relation = 'DEFINED_BY'
            )`,
        [project.id, kind]
      );
    }
    stats.definedBy = n;
  });

  // HANDLED_BY (ui_component -> symbol): reuses 1A-3's LISTENS_TO graph.
  // Sparse/optional by nature (only components that fire a listened-to
  // hook get one) -- no miss-tracking here, unlike DEFINED_BY/RENDERED_ON.
  await step("handled-by", async () => {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
       SELECT DISTINCT $2::int, c.id, listens.src_id, 'HANDLED_BY',
              jsonb_build_object('resolution_status', 'resolved',
                                  'ownership', ${OWNERSHIP_CASE_SQL("targetFile.path")})
         FROM entities c
         JOIN entities hs ON hs.project_id = $1 AND hs.kind = 'hook_site' AND hs.deleted_at IS NULL
                          AND hs.data->>'direction' = 'fire'
                          AND hs.data->>'source_path' = c.data->>'source_path'
                          AND hs.data->>'owner' = c.data->>'owner'
         JOIN entities h ON h.project_id = $1 AND h.kind = 'hook' AND h.deleted_at IS NULL
                         AND h.data->>'name' = hs.data->>'hook_name'
         JOIN entity_links listens ON listens.dst_id = h.id AND listens.relation = 'LISTENS_TO'
         JOIN symbols targetSym ON targetSym.entity_id = listens.src_id
         JOIN files targetFile ON targetFile.id = targetSym.file_id
        WHERE c.project_id = $1 AND c.kind = 'ui_component' AND c.deleted_at IS NULL
       ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
      [project.id, project.org_id]
    );
    stats.handledBy = r.rowCount ?? 0;
  });

  // CONTAINS (ui_screen -> ui_component): joined through the shared target
  // symbol entity_id both sides already resolve to (screen's RENDERED_BY,
  // component's DEFINED_BY) -- sidesteps name-collision ambiguity entirely.
  await step("contains-screen-component", async () => {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
       SELECT DISTINCT $2::int, screenRb.src_id, compDb.src_id, 'CONTAINS', '{"resolution_status":"resolved"}'::jsonb
         FROM entity_links screenRb
         JOIN entities screen ON screen.id = screenRb.src_id AND screen.project_id = $1
                              AND screen.kind = 'ui_screen' AND screen.deleted_at IS NULL
         JOIN entity_links compDb ON compDb.relation = 'DEFINED_BY' AND compDb.dst_id = screenRb.dst_id
         JOIN entities comp ON comp.id = compDb.src_id AND comp.project_id = $1
                             AND comp.kind = 'ui_component' AND comp.deleted_at IS NULL
        WHERE screenRb.relation = 'RENDERED_BY'
       ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
      [project.id, project.org_id]
    );
    stats.contains = (stats.contains || 0) + (r.rowCount ?? 0);
  });

  // CONTAINS (ui_component -> ui_settings_section/field, and flattened
  // ui_screen -> ui_settings_section/field): via settings_render_site,
  // completing 1A-2's same-file-only do_settings_sections() correlation
  // cross-file. "Unique match only" discipline on (page) -- same rule
  // resolveHookGraph()'s LISTENS_TO already applies.
  await step("contains-settings", async () => {
    for (const kind of ["ui_settings_section", "ui_settings_field"]) {
      const r1 = await pool.query(
        `WITH candidate AS (
           SELECT s.id AS section_id, min(c.id) AS comp_id, count(DISTINCT c.id) AS matches
             FROM entities s
             JOIN entities rs ON rs.project_id = $1 AND rs.kind = 'settings_render_site' AND rs.deleted_at IS NULL
                              AND rs.data->>'page' = s.data->>'page'
             JOIN entities c ON c.project_id = $1 AND c.kind = 'ui_component' AND c.deleted_at IS NULL
                             AND c.data->>'source_path' = rs.data->>'source_path'
                             AND c.data->>'owner' = rs.data->>'owner'
            WHERE s.project_id = $1 AND s.kind = $3 AND s.deleted_at IS NULL
            GROUP BY s.id
         )
         INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
         SELECT DISTINCT $2::int, comp_id, section_id, 'CONTAINS', '{"resolution_status":"resolved"}'::jsonb
           FROM candidate WHERE matches = 1
         ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
        [project.id, project.org_id, kind]
      );
      // Flattened: ui_screen -> section/field, when that same component is
      // itself CONTAINS'd by a screen (transitive, one-hop convenience).
      const r2 = await pool.query(
        `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
         SELECT DISTINCT $2::int, sc.src_id, comp.dst_id, 'CONTAINS', '{"resolution_status":"resolved"}'::jsonb
           FROM entity_links comp
           JOIN entities section ON section.id = comp.dst_id AND section.project_id = $1
                                  AND section.kind = $3 AND section.deleted_at IS NULL
           JOIN entity_links sc ON sc.relation = 'CONTAINS' AND sc.dst_id = comp.src_id
           JOIN entities screen ON screen.id = sc.src_id AND screen.kind = 'ui_screen'
          WHERE comp.relation = 'CONTAINS'
            AND comp.src_id IN (SELECT id FROM entities WHERE project_id = $1 AND kind = 'ui_component')
         ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
        [project.id, project.org_id, kind]
      );
      stats.contains = (stats.contains || 0) + (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }

    // ui_settings_section -> ui_settings_field, via (page, section) match,
    // project-wide, unique-match only.
    const r3 = await pool.query(
      `WITH candidate AS (
         SELECT f.id AS field_id, min(sec.id) AS section_id, count(DISTINCT sec.id) AS matches
           FROM entities f
           JOIN entities sec ON sec.project_id = $1 AND sec.kind = 'ui_settings_section' AND sec.deleted_at IS NULL
                             AND sec.data->>'page' = f.data->>'page'
                             AND sec.data->>'section_id' = f.data->>'section'
          WHERE f.project_id = $1 AND f.kind = 'ui_settings_field' AND f.deleted_at IS NULL
          GROUP BY f.id
       )
       INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
       SELECT DISTINCT $2::int, section_id, field_id, 'CONTAINS', '{"resolution_status":"resolved"}'::jsonb
         FROM candidate WHERE matches = 1
       ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
      [project.id, project.org_id]
    );
    stats.contains = (stats.contains || 0) + (r3.rowCount ?? 0);
  });

  // RENDERED_ON (ui_element -> ui_screen): flattened from ui_screen CONTAINS
  // ui_component RENDERS ui_element (REQ-006). Same miss semantics as
  // DEFINED_BY: unresolved (identity incomplete) vs unknown_render (identity
  // complete, genuinely no screen).
  await step("rendered-on", async () => {
    const r = await pool.query(
      `INSERT INTO entity_links (org_id, src_id, dst_id, relation, data)
       SELECT DISTINCT $2::int, renders.dst_id, sc.src_id, 'RENDERED_ON', '{"resolution_status":"resolved"}'::jsonb
         FROM entity_links renders
         JOIN entities el ON el.id = renders.dst_id AND el.project_id = $1
                          AND el.kind = 'ui_element' AND el.deleted_at IS NULL
         JOIN entity_links sc ON sc.relation = 'CONTAINS' AND sc.dst_id = renders.src_id
         JOIN entities screen ON screen.id = sc.src_id AND screen.project_id = $1
                               AND screen.kind = 'ui_screen' AND screen.deleted_at IS NULL
        WHERE renders.relation = 'RENDERS'
       ON CONFLICT (src_id, relation, dst_id) DO UPDATE SET data = EXCLUDED.data`,
      [project.id, project.org_id]
    );
    stats.renderedOn = r.rowCount ?? 0;

    // Per-relation status field: `render_status` (see "defined-by" step
    // above for why this isn't the shared `resolution_status` name).
    await pool.query(
      `UPDATE entities e
          SET data = data || jsonb_build_object('render_status', $2::text), updated_at = now()
        WHERE e.project_id = $1 AND e.kind = 'ui_element' AND e.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM entity_links el WHERE el.src_id = e.id AND el.relation = 'RENDERED_ON'
          )`,
      [project.id, missStatus]
    );
    await pool.query(
      `UPDATE entities e
          SET data = data || '{"render_status":"resolved"}'::jsonb, updated_at = now()
        WHERE e.project_id = $1 AND e.kind = 'ui_element' AND e.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM entity_links el WHERE el.src_id = e.id AND el.relation = 'RENDERED_ON'
          )`,
      [project.id]
    );
  });

  return stats;
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
