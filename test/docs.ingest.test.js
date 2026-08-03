// Embeddings off: this suite is about rows, hashes and cascades, and the one
// assertion that cares about vectors writes its own, so there is no reason to
// spend embedding API calls (or make the suite depend on a key) to run it.
//
// The src imports have to be dynamic. Static ESM imports are hoisted above this
// assignment, so config would already have been built from .env -- the chunk
// whose embedding this suite expects to see invalidated would be re-embedded
// before the assertion could look at it. test/graph.searchCode.embeddingsDisabled.test.js
// takes the same precaution for the same reason.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb, toVector } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { config } = await import("../src/config.js");
const { embeddingsEnabled } = await import("../src/embeddings.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");

const roots = [];

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-docs-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const projects = [];
function projectName(suffix) {
  const name = `docs_ingest_${suffix}`;
  projects.push(name);
  return name;
}

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

before(async () => {
  // A guard, not decoration: if this ever reports true the re-embedding
  // assertion below is silently measuring nothing.
  assert.equal(embeddingsEnabled(), false, "EMBEDDING_PROVIDER=none must be in effect");
  await initDb();
});

after(async () => {
  for (const name of projects) await cleanupTestProject(name);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

test("indexing ingests documents, chunks and the ADR block", async () => {
  const name = projectName("adr");
  const root = tmpRepo({
    "src/graph.js": "export function searchCode() { return 1; }\n",
    "docs/adr/0001-use-rrf.md":
      "---\nstatus: accepted\n---\n# Use RRF\n## Context\nTwo ranked lists.\n## Decision\nFuse with `searchCode` in src/graph.js\n",
  });

  const result = await indexProject(name, root);
  assert.equal(result.docs.documents, 1);
  assert.ok(result.docs.chunks >= 1);

  const [doc] = await q(
    `SELECT d.doc_type, d.title, d.adr->>'status' AS status, d.chunk_count, e.kind
       FROM documents d JOIN entities e ON e.id = d.entity_id
       JOIN projects p ON p.id = d.project_id
      WHERE p.name = $1 AND d.path = 'docs/adr/0001-use-rrf.md'`,
    [name]
  );
  assert.equal(doc.doc_type, "adr");
  assert.equal(doc.title, "Use RRF");
  assert.equal(doc.status, "accepted");
  assert.equal(doc.kind, "document");

  const chunks = await q(
    `SELECT c.ord, c.heading_path FROM chunks c
       JOIN documents d ON d.entity_id = c.entity_id
       JOIN projects p ON p.id = d.project_id
      WHERE p.name = $1 AND d.path = 'docs/adr/0001-use-rrf.md' ORDER BY c.ord`,
    [name]
  );
  assert.equal(chunks.length, doc.chunk_count);
  assert.ok(chunks[0].heading_path.includes("Use RRF"));
});

test("a doc mention matching exactly one symbol becomes a MENTIONS link", async () => {
  const name = projectName("mentions");
  const root = tmpRepo({
    "src/graph.js": "export function searchCode() { return 1; }\n",
    "src/a.js": "export function handle() {}\n",
    "src/b.js": "export function handle() {}\n",
    "docs/notes.md": "`searchCode` is the entry point; `handle` is everywhere.\n",
  });

  await indexProject(name, root);
  const titles = (
    await q(
      `SELECT dst.title FROM entity_links l
         JOIN entities src ON src.id = l.src_id AND src.kind = 'document'
         JOIN entities dst ON dst.id = l.dst_id
         JOIN projects p ON p.id = src.project_id
        WHERE p.name = $1 AND l.relation = 'MENTIONS'`,
      [name]
    )
  ).map((r) => r.title);

  assert.ok(titles.includes("searchCode"), "unique match links");
  assert.ok(!titles.includes("handle"), "ambiguous match does not");
});

test("path mentions are queryable from the documents row", async () => {
  const name = projectName("paths");
  const root = tmpRepo({
    "src/graph.js": "export function searchCode() {}\n",
    "docs/notes.md": "The resolver lives in src/graph.js.\n",
  });

  await indexProject(name, root);
  const rows = await q(
    `SELECT d.path FROM documents d JOIN projects p ON p.id = d.project_id
      WHERE p.name = $1 AND d.mentions->'paths' ? 'src/graph.js'`,
    [name]
  );
  assert.deepEqual(rows.map((r) => r.path), ["docs/notes.md"]);
});

test("editing one section invalidates only that chunk's embedding", async () => {
  const name = projectName("reembed");
  const big = (word) => `${word} `.repeat(400);
  const root = tmpRepo({
    "docs/guide.md": `# Guide\n## One\n${big("alpha")}\n## Two\n${big("beta")}\n`,
  });

  await indexProject(name, root);
  const chunkRows = () =>
    q(
      `SELECT c.ord, c.content_hash, c.embedding IS NULL AS unembedded
         FROM chunks c JOIN documents d ON d.entity_id = c.entity_id
         JOIN projects p ON p.id = d.project_id
        WHERE p.name = $1 AND d.path = 'docs/guide.md' ORDER BY c.ord`,
      [name]
    );

  const before = await chunkRows();
  assert.ok(before.length >= 2, "two sections produced at least two chunks");

  // Stand in for a real embedding pass, so the next index run has something to
  // preserve or invalidate.
  const fake = toVector(new Array(config.embeddingDim).fill(0.01));
  await pool.query(
    `UPDATE chunks c SET embedding = $2
       FROM documents d, projects p
      WHERE d.entity_id = c.entity_id AND p.id = d.project_id AND p.name = $1`,
    [name, fake]
  );

  fs.writeFileSync(
    path.join(root, "docs/guide.md"),
    `# Guide\n## One\n${big("alpha")}\n## Two\n${big("gamma")}\n`
  );
  await indexProject(name, root);

  const after = await chunkRows();
  assert.equal(after[0].content_hash, before[0].content_hash, "first chunk untouched");
  assert.equal(after[0].unembedded, false, "and keeps its embedding");
  assert.notEqual(after.at(-1).content_hash, before.at(-1).content_hash, "edited chunk rehashed");
  assert.equal(after.at(-1).unembedded, true, "and is queued for re-embedding");
});

test("an unchanged doc is hash-skipped on re-index", async () => {
  const name = projectName("skip");
  const root = tmpRepo({ "docs/guide.md": "# Guide\ntext\n" });

  await indexProject(name, root);
  const second = await indexProject(name, root);
  assert.equal(second.docs.documents, 0, "no document re-written");
  assert.ok(second.skipped >= 1);
});

test("deleting a doc removes its entity and chunks", async () => {
  const name = projectName("delete");
  const root = tmpRepo({
    "docs/guide.md": "# Guide\ntext\n",
    "src/a.js": "export function a() {}\n",
  });

  await indexProject(name, root);
  fs.rmSync(path.join(root, "docs/guide.md"));
  await indexProject(name, root);

  const docs = await q(
    `SELECT 1 FROM documents d JOIN projects p ON p.id = d.project_id
      WHERE p.name = $1 AND d.path = 'docs/guide.md'`,
    [name]
  );
  assert.equal(docs.length, 0);

  const orphans = await q(
    `SELECT 1 FROM chunks c LEFT JOIN entities e ON e.id = c.entity_id WHERE e.id IS NULL`
  );
  assert.equal(orphans.length, 0, "no chunks left without an entity");
});

test("DOCS_ENABLED=0 ingests no documents", async () => {
  const name = projectName("disabled");
  const root = tmpRepo({ "docs/guide.md": "# Guide\ntext\n", "src/a.js": "export function a() {}\n" });

  const prev = config.docsEnabled;
  config.docsEnabled = false;
  try {
    const result = await indexProject(name, root);
    assert.equal(result.docs, null);
    const docs = await q(
      `SELECT 1 FROM documents d JOIN projects p ON p.id = d.project_id WHERE p.name = $1`,
      [name]
    );
    assert.equal(docs.length, 0);
  } finally {
    config.docsEnabled = prev;
  }
});
