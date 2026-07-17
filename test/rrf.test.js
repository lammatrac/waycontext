import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRankedLists } from "../src/rrf.js";

test("empty ranked lists produce no results", () => {
  assert.deepEqual(fuseRankedLists({}), []);
  assert.deepEqual(fuseRankedLists({ fts: [], vector: [] }), []);
});

test("a single ranked list preserves its order with decreasing scores", () => {
  const result = fuseRankedLists({ fts: ["a", "b", "c"] });
  assert.deepEqual(result.map((r) => r.id), ["a", "b", "c"]);
  assert.ok(result[0].score > result[1].score);
  assert.ok(result[1].score > result[2].score);
  assert.deepEqual(result[0].sources, ["fts"]);
});

test("an id ranked in both lists outranks ids ranked in only one", () => {
  const result = fuseRankedLists({
    fts: ["a", "b", "c"],
    vector: ["b", "a", "d"],
  });
  const byId = Object.fromEntries(result.map((r) => [r.id, r]));
  // "a" and "b" both appear in both lists; "c" and "d" appear in only one.
  assert.ok(byId.a.score > byId.c.score);
  assert.ok(byId.b.score > byId.d.score);
  assert.deepEqual(byId.a.sources.slice().sort(), ["fts", "vector"]);
  assert.deepEqual(byId.c.sources, ["fts"]);
  assert.deepEqual(byId.d.sources, ["vector"]);
});

test("results are sorted by fused score descending", () => {
  const result = fuseRankedLists({ fts: ["x", "y"], vector: ["y", "x"] });
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i - 1].score >= result[i].score);
  }
});

test("a smaller k constant increases the score gap between top and lower ranks", () => {
  const lenient = fuseRankedLists({ fts: ["a", "b"] }, 60);
  const strict = fuseRankedLists({ fts: ["a", "b"] }, 1);
  const gapLenient = lenient[0].score - lenient[1].score;
  const gapStrict = strict[0].score - strict[1].score;
  assert.ok(gapStrict > gapLenient);
});
