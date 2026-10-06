import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { config } from "../src/config.js";
import { indexProject, embedPending, writeEmbeddings } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

/**
 * The embedding phase used to send one 64-text batch at a time and write each
 * returned vector with its own UPDATE. On a WordPress install (~100k symbols)
 * that was ~1,500 serial provider round trips plus ~100k serial DB round trips
 * -- most of a 19-minute first index.
 */

const PROJECT = "wc_embed_pending_test";
let dir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: i, text: `t${i}` }));
const tick = () => new Promise((r) => setTimeout(r, 5));

test("batches run concurrently, bounded by the concurrency limit", async () => {
  let inFlight = 0, maxInFlight = 0;
  const embedFn = async (texts) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return texts.map(() => [1]);
  };
  const written = [];
  const res = await embedPending(items(100), {
    embedFn, batchSize: 10, concurrency: 3, write: async (b) => { written.push(...b); },
  });
  assert.equal(maxInFlight, 3);
  assert.equal(res.embedded, 100);
  assert.equal(res.failed, 0);
  assert.deepEqual(written.map((w) => w.id).sort((a, b) => a - b), items(100).map((i) => i.id));
});

test("a failed batch is counted and logged without losing the others", async () => {
  const lines = [];
  const embedFn = async (texts) => {
    if (texts.includes("t10")) throw new Error("Voyage API 400: bad input");
    return texts.map(() => [1]);
  };
  const written = [];
  const res = await embedPending(items(30), {
    embedFn, batchSize: 10, concurrency: 2, retryDelayMs: 0,
    write: async (b) => { written.push(...b); }, log: (m) => lines.push(m),
  });
  assert.equal(res.embedded, 20);
  assert.equal(res.failed, 10);
  assert.equal(written.length, 20);
  assert.match(lines.join("\n"), /batch failed \(10 .*400/);
});

test("a rate-limited batch is retried instead of being left without embeddings", async () => {
  let calls = 0;
  const embedFn = async (texts) => {
    calls++;
    if (calls === 1) throw new Error("Voyage API 429: rate limit exceeded");
    return texts.map(() => [1]);
  };
  const res = await embedPending(items(5), {
    embedFn, batchSize: 10, concurrency: 1, retryDelayMs: 0, write: async () => {},
  });
  assert.equal(res.embedded, 5);
  assert.equal(res.failed, 0);
  assert.equal(calls, 2);
});

test("writeEmbeddings stores every vector of a batch in one statement", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-embed-"));
  fs.writeFileSync(path.join(dir, "a.js"), "function a() { return 1; }\nfunction b() { return 2; }\n");
  await indexProject(PROJECT, dir, () => {});
  const { rows: syms } = await pool.query(
    `SELECT s.id FROM symbols s JOIN projects p ON p.id = s.project_id
      WHERE p.name = $1 ORDER BY s.id`,
    [PROJECT]
  );
  assert.equal(syms.length, 2, "precondition: two symbols indexed");

  const vec = (x) => Array.from({ length: config.embeddingDim }, () => x);
  let statements = 0;
  const origQuery = pool.query.bind(pool);
  pool.query = (...args) => { statements++; return origQuery(...args); };
  try {
    await writeEmbeddings("symbols", [
      { id: syms[0].id, vector: vec(0.25) },
      { id: syms[1].id, vector: vec(0.5) },
    ]);
  } finally {
    pool.query = origQuery;
  }
  assert.equal(statements, 1);

  const { rows } = await pool.query(
    `SELECT id, (embedding::real[])[1] AS first FROM symbols WHERE id = ANY($1) ORDER BY id`,
    [syms.map((s) => s.id)]
  );
  assert.deepEqual(rows.map((r) => r.first), [0.25, 0.5]);
});
