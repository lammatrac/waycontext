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
  // name (weight A) into "purge"/"cache"/etc.
  await insertTestSymbol(project.id, fileId, {
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
  assert.equal(results[0].name, "purgeCacheAfterMatchUpdate");
  assert.deepEqual(results[0].matched_via, ["fts"]);
});

test("a description-style query matches symbols that contain only some of its words", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "table.php");
  // Shares "comparison", "table" and "filter" with the query below, but none
  // of "categories", "tags", "hide", "empty", "zero" or "cards". An AND query
  // (plainto_tsquery) needs all ten words in one symbol and finds nothing.
  await insertTestSymbol(project.id, fileId, {
    name: "comparison_table_build_filter_data",
    doc: "Build the filter data for the comparison table.",
    body: "function comparison_table_build_filter_data() { return []; }",
  });
  await insertTestSymbol(project.id, fileId, {
    name: "renderFooter",
    body: "function renderFooter() { return '<footer/>'; }",
  });

  const results = await searchCode(
    PROJECT, "comparison table filter categories tags hide empty with zero cards", 5
  );
  assert.equal(results[0]?.name, "comparison_table_build_filter_data");
  assert.ok(!results.some((r) => r.name === "renderFooter"));
});

test("stopwords alone do not match every symbol", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "noise.js");
  await insertTestSymbol(project.id, fileId, {
    name: "noisy",
    body: "function noisy() { for (const x of the.list) with (x) {} }",
  });
  // "with" and "for" are in the body, but OR-ing stopwords would rank every
  // symbol on noise; only "frobnicate" carries meaning and nothing has it.
  const results = await searchCode(PROJECT, "frobnicate with the for", 5);
  assert.deepEqual(results, []);
});
