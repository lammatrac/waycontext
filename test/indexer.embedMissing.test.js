// Pinned before any import: config is read once at load. embedFn is always a
// stub, so nothing here calls the provider.
process.env.EMBEDDING_PROVIDER = "voyage";
process.env.VOYAGE_MODEL = "wc-test-model";
process.env.VOYAGE_API_KEY = "test-key-unused";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb, toVector } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { embedMissing } = await import("../src/indexer.js");
const {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} = await import("./helpers/testProject.js");

const PROJECT = "wc_embed_missing_fixture";

const vec = () => {
  const v = new Array(config.embeddingDim).fill(0);
  v[0] = 1;
  return v;
};

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("embedMissing embeds only rows without a vector, and indexes nothing", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "a.js");
  await insertTestSymbol(project.id, fileId, { name: "done", body: "x", embedding: toVector(vec()) });
  const missing = await insertTestSymbol(project.id, fileId, { name: "todo", body: "function todo() {}" });
  const filesBefore = await pool.query(`SELECT count(*)::int n FROM files WHERE project_id = $1`, [project.id]);

  const calls = [];
  const result = await embedMissing(project, {
    embedFn: async (texts) => { calls.push(...texts); return texts.map(vec); },
  });

  assert.deepEqual(calls, ["// a.js (function todo)\n\nfunction todo() {}"]);
  assert.equal(result.symbols.embedded, 1);
  const r = await pool.query(`SELECT embedding IS NOT NULL AS has FROM symbols WHERE id = $1`, [missing]);
  assert.equal(r.rows[0].has, true);
  const filesAfter = await pool.query(`SELECT count(*)::int n FROM files WHERE project_id = $1`, [project.id]);
  assert.equal(filesAfter.rows[0].n, filesBefore.rows[0].n);
});
