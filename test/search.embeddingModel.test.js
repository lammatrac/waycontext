// Pinned before any import: config is read once at load, and these tests need
// a known current model without spending provider credits (nothing here calls
// the API -- every vector is written by hand).
process.env.EMBEDDING_PROVIDER = "voyage";
process.env.VOYAGE_MODEL = "wc-test-model";
process.env.VOYAGE_API_KEY = "test-key-unused";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb, toVector } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { vectorCandidates, findRelated } = await import("../src/graph.js");
const { embeddingModelId, clearStaleEmbeddings } = await import("../src/embeddings.js");
const { writeEmbeddings } = await import("../src/indexer.js");
const {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} = await import("./helpers/testProject.js");

const PROJECT = "wc_embedding_model_fixture";
const CURRENT = "voyage:wc-test-model";
const OLD = "voyage:wc-old-model";

/** Unit vector along `axis`, nudged toward axis 1 so distances differ. */
function vec(axis, nudge = 0) {
  const v = new Array(config.embeddingDim).fill(0);
  v[axis] = 1;
  v[1] += nudge;
  return v;
}

async function symbolWithModel(projectId, fileId, name, model, vector = vec(0)) {
  const id = await insertTestSymbol(projectId, fileId, { name, embedding: toVector(vector) });
  await pool.query(`UPDATE symbols SET embedding_model = $2 WHERE id = $1`, [id, model]);
  return id;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("embeddingModelId names the configured provider and model", () => {
  assert.equal(embeddingModelId(), CURRENT);
});

test("writeEmbeddings stamps the model that produced the vector", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "stamp.js");
  const id = await insertTestSymbol(project.id, fileId, { name: "stampMe" });

  await writeEmbeddings("symbols", [{ id, vector: vec(0) }]);

  const res = await pool.query(`SELECT embedding_model FROM symbols WHERE id = $1`, [id]);
  assert.equal(res.rows[0].embedding_model, CURRENT);
});

test("vector search ignores vectors from another model", async () => {
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "models.js");
  // The stale row is the nearer one: it must be excluded, not out-ranked.
  await symbolWithModel(project.id, fileId, "staleNearest", OLD, vec(0));
  await symbolWithModel(project.id, fileId, "currentFar", CURRENT, vec(0, 0.5));

  const rows = await vectorCandidates(project, vec(0), 50);
  assert.deepEqual(rows.map((r) => r.name), ["currentFar"]);
});

test("legacy rows count as current only when the project's legacy model matches", async () => {
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "legacy.js");
  await symbolWithModel(project.id, fileId, "legacyRow", null);

  assert.deepEqual(await vectorCandidates(project, vec(0), 50), [],
    "unknown provenance must not be compared against a current query");

  await pool.query(`UPDATE projects SET legacy_embedding_model = $2 WHERE id = $1`, [project.id, CURRENT]);
  const withLegacy = { ...project, legacy_embedding_model: CURRENT };
  assert.deepEqual((await vectorCandidates(withLegacy, vec(0), 50)).map((r) => r.name), ["legacyRow"]);
});

test("vector search returns a project's rows even when other projects hold nearer vectors", async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(`${PROJECT}_other`);
  const project = await createTestProject(PROJECT);
  const other = await createTestProject(`${PROJECT}_other`);
  try {
    const otherFile = await insertTestFile(other.id, "crowd.js");
    // More exact matches elsewhere than hnsw.ef_search (40) will visit: a
    // post-filtered index scan sees only these and returns nothing for PROJECT.
    for (let i = 0; i < 60; i++) {
      await symbolWithModel(other.id, otherFile, `crowd${i}`, CURRENT, vec(0));
    }
    const fileId = await insertTestFile(project.id, "mine.js");
    await symbolWithModel(project.id, fileId, "mine", CURRENT, vec(0, 0.5));

    const rows = await vectorCandidates(project, vec(0), 50);
    assert.deepEqual(rows.map((r) => r.name), ["mine"]);
  } finally {
    await cleanupTestProject(`${PROJECT}_other`);
  }
});

test("findRelated only pairs vectors from the same model", async () => {
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "related.js");
  await symbolWithModel(project.id, fileId, "anchor", CURRENT, vec(0));
  await symbolWithModel(project.id, fileId, "sameModel", CURRENT, vec(0, 0.5));
  await symbolWithModel(project.id, fileId, "otherModel", OLD, vec(0));

  const rows = await findRelated(PROJECT, "anchor", 10);
  assert.deepEqual(rows.map((r) => r.name), ["sameModel"]);
});

test("clearStaleEmbeddings nulls only vectors from another model, and dry-run changes nothing", async () => {
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "clear.js");
  const keep = await symbolWithModel(project.id, fileId, "keep", CURRENT);
  const stale = await symbolWithModel(project.id, fileId, "stale", OLD);
  const unknown = await symbolWithModel(project.id, fileId, "unknown", null);

  const dry = await clearStaleEmbeddings(project, { dryRun: true });
  assert.equal(dry.symbols, 2);
  const untouched = await pool.query(
    `SELECT count(*)::int AS n FROM symbols WHERE project_id = $1 AND embedding IS NOT NULL`, [project.id]
  );
  assert.equal(untouched.rows[0].n, 3);

  const done = await clearStaleEmbeddings(project);
  assert.equal(done.symbols, 2);
  const res = await pool.query(
    `SELECT id, embedding IS NOT NULL AS has FROM symbols WHERE id = ANY($1)`, [[keep, stale, unknown]]
  );
  const has = Object.fromEntries(res.rows.map((r) => [r.id, r.has]));
  assert.deepEqual([has[keep], has[stale], has[unknown]], [true, false, false]);
});
