import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, toVector } from "../src/db.js";
import { searchCode } from "../src/graph.js";
import { embed } from "../src/embeddings.js";
import {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} from "./helpers/testProject.js";

const PROJECT_FUSED = "hybrid_search_code_fused_fixture";
const hasEmbeddingKey = Boolean(process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY);

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT_FUSED);
});

after(async () => {
  await cleanupTestProject(PROJECT_FUSED);
  await pool.end();
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
