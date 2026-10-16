// Pinned before any import: config is read once at load. No test here calls
// the provider -- embedFn is always a stub that records what it was asked for.
process.env.EMBEDDING_PROVIDER = "voyage";
process.env.VOYAGE_MODEL = "wc-test-model";
process.env.VOYAGE_API_KEY = "test-key-unused";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb, toVector } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { embedWithReuse, embedTextHash } = await import("../src/indexer.js");
const {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} = await import("./helpers/testProject.js");

const A = "wc_embed_reuse_a";
const B = "wc_embed_reuse_b";

function vec(axis) {
  const v = new Array(config.embeddingDim).fill(0);
  v[axis] = 1;
  return v;
}

/** Stub provider: one distinct vector per call position, and a log of texts. */
function stubEmbed() {
  const calls = [];
  const embedFn = async (texts) => {
    calls.push(...texts);
    return texts.map((_, i) => vec(10 + calls.length - texts.length + i));
  };
  return { calls, embedFn };
}

async function row(id) {
  const r = await pool.query(
    `SELECT embedding::text AS v, embedding_model, embed_hash FROM symbols WHERE id = $1`, [id]
  );
  return r.rows[0];
}

before(async () => {
  await initDb();
  await cleanupTestProject(A);
  await cleanupTestProject(B);
});

after(async () => {
  await cleanupTestProject(A);
  await cleanupTestProject(B);
  await pool.end();
});

test("a text already embedded by the current model in another project is copied, not re-embedded", async () => {
  const a = await createTestProject(A);
  const b = await createTestProject(B);
  const text = "// wp-content/plugins/seo/x.php (function seo_x)\n\nfunction seo_x() {}";
  const fa = await insertTestFile(a.id, "x.php");
  const fb = await insertTestFile(b.id, "x.php");
  const src = await insertTestSymbol(a.id, fa, { name: "seo_x" });
  const dst = await insertTestSymbol(b.id, fb, { name: "seo_x" });

  const first = stubEmbed();
  await embedWithReuse("symbols", [{ id: src, text }], { embedFn: first.embedFn, orgId: a.org_id });
  assert.deepEqual(first.calls, [text]);

  const second = stubEmbed();
  const result = await embedWithReuse("symbols", [{ id: dst, text }], { embedFn: second.embedFn, orgId: b.org_id });
  assert.deepEqual(second.calls, [], "the provider must not be asked again");
  assert.equal(result.reused, 1);

  const [s, d] = [await row(src), await row(dst)];
  assert.equal(d.v, s.v);
  assert.equal(d.embedding_model, "voyage:wc-test-model");
  assert.equal(d.embed_hash, embedTextHash(text));
});

test("identical texts inside one batch are embedded once and written to every row", async () => {
  await cleanupTestProject(A);
  const a = await createTestProject(A);
  const f = await insertTestFile(a.id, "dup.js");
  const ids = [
    await insertTestSymbol(a.id, f, { name: "one" }),
    await insertTestSymbol(a.id, f, { name: "two" }),
    await insertTestSymbol(a.id, f, { name: "three" }),
  ];
  const { calls, embedFn } = stubEmbed();
  const result = await embedWithReuse("symbols", [
    { id: ids[0], text: "same body" },
    { id: ids[1], text: "same body" },
    { id: ids[2], text: "other body" },
  ], { embedFn, orgId: a.org_id });

  assert.deepEqual(calls.sort(), ["other body", "same body"]);
  assert.equal(result.embedded, 3);
  const [r0, r1, r2] = [await row(ids[0]), await row(ids[1]), await row(ids[2])];
  assert.equal(r0.v, r1.v);
  assert.notEqual(r0.v, r2.v);
});

test("a vector from another model is never reused", async () => {
  await cleanupTestProject(A);
  await cleanupTestProject(B);
  const a = await createTestProject(A);
  const b = await createTestProject(B);
  const text = "stale model text";
  const fa = await insertTestFile(a.id, "s.js");
  const fb = await insertTestFile(b.id, "s.js");
  const old = await insertTestSymbol(a.id, fa, { name: "old", embedding: toVector(vec(3)) });
  await pool.query(
    `UPDATE symbols SET embedding_model = 'voyage:wc-old-model', embed_hash = $2 WHERE id = $1`,
    [old, embedTextHash(text)]
  );
  const dst = await insertTestSymbol(b.id, fb, { name: "fresh" });

  const { calls, embedFn } = stubEmbed();
  const result = await embedWithReuse("symbols", [{ id: dst, text }], { embedFn, orgId: b.org_id });
  assert.deepEqual(calls, [text]);
  assert.equal(result.reused, 0);
});
