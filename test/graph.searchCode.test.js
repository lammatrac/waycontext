import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, toVector } from "../src/db.js";
import { searchCode } from "../src/graph.js";
import { embed } from "../src/embeddings.js";
import {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} from "./helpers/testProject.js";

const PROJECT = "hybrid_search_code_fixture";
const PROJECT_FUSED = "hybrid_search_code_fused_fixture";
const hasEmbeddingKey = Boolean(process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY);

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(PROJECT_FUSED);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(PROJECT_FUSED);
  await pool.end();
});

test("FTS-only search ranks a name match above a body-only match and reports matched_via", async () => {
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  process.env.EMBEDDING_PROVIDER = "none";
  try {
    const project = await createTestProject(PROJECT);
    const fileId = await insertTestFile(project.id, "widgets.js");
    // Postgres's `simple` FTS config doesn't split camelCase identifiers into
    // separate words, so a multi-word query only matches this symbol through
    // its prose `doc` (weight B) -- not by decomposing the `purgeCache...`
    // name (weight A) into "purge"/"cache"/etc. The doc spells out the same
    // words a natural-language query would use, the way real doc comments do.
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
  } finally {
    process.env.EMBEDDING_PROVIDER = originalProvider;
  }
});

test(
  "fused search surfaces a vector-only match when embeddings are enabled",
  { skip: !hasEmbeddingKey && "no VOYAGE_API_KEY/OPENAI_API_KEY set" },
  async () => {
    const project = await createTestProject(PROJECT_FUSED);
    const fileId = await insertTestFile(project.id, "auth.js");
    // Shares no lexical terms with the query below, so it can only be found
    // via semantic similarity -- proves the vector list actually contributes.
    // insertTestSymbol stores whatever embedding it's given (it doesn't compute
    // one), so we embed the symbol's text ourselves via the real provider,
    // the same way src/indexer.js does when indexing a project.
    const doc = "Issues a fresh signing key and revokes the previous one.";
    const body = "function rotateSecretKey() { keystore.issue(); keystore.revokePrevious(); }";
    const [vector] = await embed([`${doc}\n${body}`], "document");
    const vectorOnlyId = await insertTestSymbol(project.id, fileId, {
      name: "rotateSecretKey",
      doc,
      body,
      embedding: toVector(vector),
    });

    const results = await searchCode(project.name, "replace the credential used to sign tokens", 10);
    const match = results.find((r) => r.id === vectorOnlyId);
    assert.ok(match, "expected the semantically-related symbol to appear in results");
    assert.deepEqual(match.matched_via, ["vector"]);
  }
);
