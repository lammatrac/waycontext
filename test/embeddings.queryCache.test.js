// A fake provider, so the cache is tested by counting real calls rather than by
// trusting it. Set before any src import: config is built at module load.
process.env.EMBEDDING_PROVIDER = "voyage";
process.env.VOYAGE_API_KEY = "test-key-not-used";
process.env.EMBEDDING_DIM = "4";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { embedQuery, clearQueryCache, queryCacheStats } =
  await import("../src/embeddings.js");
const { pool } = await import("../src/db.js");

const realFetch = globalThis.fetch;
let calls = 0;
let delayMs = 0;

before(() => {
  globalThis.fetch = async (_url, init) => {
    calls++;
    const { input } = JSON.parse(init.body);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return {
      ok: true,
      json: async () => ({
        data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })),
        usage: { total_tokens: 3 },
      }),
    };
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
});

beforeEach(() => {
  clearQueryCache();
  calls = 0;
  delayMs = 0;
});

test("the same query is embedded once", async () => {
  await embedQuery("who owns the indexer");
  await embedQuery("who owns the indexer");
  await embedQuery("who owns the indexer");
  assert.equal(calls, 1);
});

test("different queries are not conflated", async () => {
  await embedQuery("a");
  await embedQuery("b");
  assert.equal(calls, 2);
  assert.equal(queryCacheStats().size, 2);
});

test("concurrent identical queries share one in-flight call", async () => {
  // The case that matters: the composer runs its channels in parallel and two of
  // them embed the SAME task text at the same instant. Caching only resolved
  // values would still make two API calls.
  delayMs = 40;
  const [a, b, c] = await Promise.all([
    embedQuery("simultaneous"), embedQuery("simultaneous"), embedQuery("simultaneous"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("a failed call is not cached, so the next attempt retries", async () => {
  const working = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "boom" };
  };
  try {
    await assert.rejects(() => embedQuery("flaky"), /Voyage API 500/);
    await assert.rejects(() => embedQuery("flaky"), /Voyage API 500/);
    assert.equal(calls, 2, "a poisoned cache would have made this 1");
    assert.equal(queryCacheStats().size, 0);
  } finally {
    globalThis.fetch = working;
  }
});

test("the cache is keyed on the embedding space, not just the text", async () => {
  const { config } = await import("../src/config.js");
  await embedQuery("same text");
  const originalDim = config.embeddingDim;
  config.embeddingDim = 8; // as if EMBEDDING_DIM were changed
  try {
    await embedQuery("same text");
    assert.equal(calls, 2, "vectors from a different space must not be reused");
  } finally {
    config.embeddingDim = originalDim;
  }
});

test("the cache is bounded", async () => {
  for (let i = 0; i < 300; i++) await embedQuery(`query ${i}`);
  const { size, max } = queryCacheStats();
  assert.ok(size <= max, `${size} > ${max}`);
  assert.equal(max, 256);
});

test("with the provider off, nothing is cached and nothing is called", async () => {
  const { config } = await import("../src/config.js");
  const original = config.embeddingProvider;
  config.embeddingProvider = "none";
  try {
    assert.equal(await embedQuery("anything"), null);
    assert.equal(calls, 0);
    assert.equal(queryCacheStats().size, 0, "caching null would lie once it is switched back on");
  } finally {
    config.embeddingProvider = original;
  }
});
