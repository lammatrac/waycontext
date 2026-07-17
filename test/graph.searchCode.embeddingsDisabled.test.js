process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb } = await import("../src/db.js");
const { searchCode } = await import("../src/graph.js");
const { embeddingsEnabled } = await import("../src/embeddings.js");
const {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} = await import("./helpers/testProject.js");

const PROJECT = "hybrid_search_code_disabled_fixture";

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("embeddingsEnabled() is false when EMBEDDING_PROVIDER=none is set before any import", () => {
  assert.equal(embeddingsEnabled(), false);
});

test("FTS-only search ranks a name match above a body-only match and reports matched_via", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "widgets.js");
  // Postgres's `simple` FTS config doesn't split camelCase identifiers into
  // separate words, so a multi-word query only matches this symbol through
  // its prose `doc` (weight B) -- not by decomposing the `purgeCache...`
  // name (weight A) into "purge"/"cache"/etc. The doc must contain every
  // query word since plainto_tsquery ANDs terms together.
  const nameMatchId = await insertTestSymbol(project.id, fileId, {
    name: "purgeCacheAfterMatchUpdate",
    doc: "Purge the cache after a match result update occurs.",
    body: "function purgeCacheAfterMatchUpdate() { cache.del('scoreboard'); }",
  });
  // Contains the same query words, but only in the lowest-weighted `body`
  // field, so it should still match (proving the ranking, not just the
  // match, is exercised) but rank below nameMatchId.
  await insertTestSymbol(project.id, fileId, {
    name: "unrelatedThing",
    body: "function unrelatedThing() { /* purge cache after match update in the scoreboard */ }",
  });

  const results = await searchCode(PROJECT, "purge cache after match update", 5);
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, nameMatchId);
  assert.deepEqual(results[0].matched_via, ["fts"]);
});
