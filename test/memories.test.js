// Embeddings off, src imports dynamic — see test/docs.ingest.test.js.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb, getOrCreateProject } = await import("../src/db.js");
const { remember, recall } = await import("../src/knowledge/memory.js");
const { searchKnowledge } = await import("../src/graph.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "memories_fixture";

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await getOrCreateProject(PROJECT, "/tmp/memories_fixture");
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("remembering writes an entity, a satellite and a chunk", async () => {
  const saved = await remember(PROJECT, {
    content: "The embedding cache keys on the normalized task, so changing whitespace misses.",
    kind: "gotcha",
  });
  assert.match(saved.key, /^mem:[0-9a-f]{12}$/);
  assert.equal(saved.chunks, 1);

  const rows = await pool.query(
    `SELECT e.kind AS entity_kind, m.kind, m.source, count(c.id)::int AS chunks
       FROM memories m
       JOIN entities e ON e.id = m.entity_id
       LEFT JOIN chunks c ON c.entity_id = m.entity_id
      WHERE m.entity_id = $1
      GROUP BY e.kind, m.kind, m.source`,
    [saved.id]
  );
  assert.equal(rows.rows[0].entity_kind, "memory");
  assert.equal(rows.rows[0].kind, "gotcha");
  assert.equal(rows.rows[0].source, "agent");
  assert.equal(rows.rows[0].chunks, 1);
});

test("remembering the same thing twice is idempotent", async () => {
  const a = await remember(PROJECT, { content: "Ports collide when fixtures share 5432." });
  const b = await remember(PROJECT, { content: "Ports collide when fixtures share 5432." });
  assert.equal(a.id, b.id);
});

test("recall finds a memory by its words with embeddings off", async () => {
  await remember(PROJECT, { content: "Voyage rate-limits at 300 requests per minute." });
  const hits = await recall(PROJECT, "voyage rate limits requests", 5);
  assert.ok(hits.some((h) => /rate-limits/.test(h.content)), JSON.stringify(hits, null, 1));
});

test("a superseded memory stops being recalled", async () => {
  const old = await remember(PROJECT, { content: "The retry budget is three attempts total." });
  await remember(PROJECT, {
    content: "The retry budget is five attempts total since the timeout change.",
    supersedes: old.key,
  });
  const hits = await recall(PROJECT, "retry budget attempts", 10);
  assert.ok(hits.some((h) => /five attempts/.test(h.content)), "the correction is recalled");
  assert.ok(!hits.some((h) => /three attempts/.test(h.content)), "the old belief is hidden");
});

test("pinned memories come first", async () => {
  await remember(PROJECT, {
    content: "Always read the migration ledger before a schema change.",
    pinned: true,
  });
  const hits = await recall(PROJECT, "schema change ledger", 10);
  assert.equal(hits[0].pinned, true);
});

test("memories surface in search_knowledge tagged as memory", async () => {
  await remember(PROJECT, { content: "The advisory lock is keyed by project id, not by path." });
  const hits = await searchKnowledge(PROJECT, "advisory lock keyed project", 10);
  const memory = hits.find((h) => h.type === "memory");
  assert.ok(memory, JSON.stringify(hits, null, 1));
  assert.match(memory.heading_path, /^memory:/);
});

test("a memory needs content", async () => {
  await assert.rejects(() => remember(PROJECT, { content: "   " }), /needs content/);
});

test("superseding an unknown memory is an error, not a silent no-op", async () => {
  await assert.rejects(
    () => remember(PROJECT, { content: "Something new entirely here.", supersedes: "mem:deadbeef0000" }),
    /to supersede/
  );
});
