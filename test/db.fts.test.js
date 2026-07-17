import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb } from "../src/db.js";
import {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} from "./helpers/testProject.js";

const PROJECT = "hybrid_search_fts_fixture";
const PROJECT_RANK = "hybrid_search_fts_rank_fixture";

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(PROJECT_RANK);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(PROJECT_RANK);
  await pool.end();
});

test("fts_vector generated column exists and is populated on insert", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "cache.js");
  const symbolId = await insertTestSymbol(project.id, fileId, {
    name: "purgeCacheAfterMatchUpdate",
    doc: "Purge the cache when a match score changes.",
    body: "function purgeCacheAfterMatchUpdate() { cache.del('scoreboard'); }",
  });

  const res = await pool.query(
    `SELECT fts_vector IS NOT NULL AS has_fts,
            fts_vector @@ plainto_tsquery('simple', 'purge cache') AS matches_doc_terms,
            fts_vector @@ plainto_tsquery('simple', 'purgeCacheAfterMatchUpdate') AS matches_name
     FROM symbols WHERE id = $1`,
    [symbolId]
  );
  assert.equal(res.rows[0].has_fts, true);
  assert.equal(res.rows[0].matches_doc_terms, true);
  assert.equal(res.rows[0].matches_name, true);
});

test("name matches rank above body-only matches", async () => {
  const project = await createTestProject(PROJECT_RANK);
  const fileId = await insertTestFile(project.id, "rank.js");
  const nameMatchId = await insertTestSymbol(project.id, fileId, {
    name: "widgetLoader",
    body: "function widgetLoader() { return true; }",
  });
  const bodyOnlyMatchId = await insertTestSymbol(project.id, fileId, {
    name: "unrelatedThing",
    body: "function unrelatedThing() { const widgetLoader = getWidgetLoader(); return widgetLoader; }",
  });

  const res = await pool.query(
    `SELECT id, ts_rank(fts_vector, plainto_tsquery('simple', 'widgetLoader')) AS rank
     FROM symbols WHERE id = ANY($1) ORDER BY rank DESC`,
    [[nameMatchId, bodyOnlyMatchId]]
  );
  assert.equal(res.rows[0].id, nameMatchId);
});
