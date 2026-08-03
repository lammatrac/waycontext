import test from "node:test";
import assert from "node:assert/strict";
import {
  fuseWeighted, packBudget, estimateTokens, DEFAULT_WEIGHTS,
} from "../src/context/pack.js";

const item = (key, extra = {}) => ({ key, type: "code", title: key, ref: key, snippet: null, ...extra });

test("a heavier channel outranks a lighter one at the same rank", () => {
  const fused = fuseWeighted({
    code: [item("a")],
    graph: [item("b")],
  }, DEFAULT_WEIGHTS);
  assert.equal(fused[0].key, "a");
  assert.ok(fused[0].score > fused[1].score);
});

test("an item found by two channels beats one found by a single better channel", () => {
  const fused = fuseWeighted({
    code: [item("only-code"), item("both")],
    memory: [item("both")],
  }, DEFAULT_WEIGHTS);
  assert.equal(fused[0].key, "both");
  assert.deepEqual(fused[0].channels, ["code", "memory"]);
});

test("a channel with zero weight contributes nothing", () => {
  const fused = fuseWeighted({ code: [item("a")], graph: [item("b")] }, { code: 1, graph: 0 });
  assert.deepEqual(fused.map((f) => f.key), ["a"]);
});

test("merging keeps the richer copy of a duplicate", () => {
  // The graph channel knows a symbol's neighbours but carries no snippet.
  // Losing the snippet because the graph was merged second is a downgrade.
  const fused = fuseWeighted({
    graph: [item("x")],
    code: [item("x", { snippet: "function x() {}" })],
  }, DEFAULT_WEIGHTS);
  assert.equal(fused[0].item.snippet, "function x() {}");
});

test("ties are broken deterministically", () => {
  const lists = { code: [item("b"), item("a")] };
  assert.deepEqual(
    fuseWeighted(lists, DEFAULT_WEIGHTS).map((f) => f.key),
    fuseWeighted(lists, DEFAULT_WEIGHTS).map((f) => f.key)
  );
});

test("token estimates are proportional and forgiving of null", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("rules survive a budget too small for anything else", () => {
  // The load-bearing behaviour of the whole file: an agent that never saw
  // "never edit an applied migration" will confidently edit one, while a missing
  // code snippet only makes it search again.
  const rules = [
    { key: "rule:1", type: "rule", title: "Never edit an applied migration", ref: "doc", snippet: null },
  ];
  const fused = fuseWeighted({ code: [item("big", { snippet: "x".repeat(4000) })] }, DEFAULT_WEIGHTS);

  const packed = packBudget(fused, rules, 20);
  assert.equal(packed.included.length, 1);
  assert.equal(packed.included[0].type, "rule");
  assert.equal(packed.included[0].pinned, true);
  assert.equal(packed.dropped_count, 1);
});

test("a budget overspent by rules alone is reported, not silently obeyed", () => {
  const rules = Array.from({ length: 5 }, (_, i) => ({
    key: `rule:${i}`, type: "rule", title: "x".repeat(200), ref: "doc", snippet: null,
  }));
  const packed = packBudget([], rules, 50);
  assert.equal(packed.included.length, 5, "all rules still included");
  assert.equal(packed.over_budget, true);
  assert.ok(packed.tokens > 50);
});

test("items are included in fused order until the budget runs out", () => {
  const fused = fuseWeighted({
    code: [item("first", { snippet: "a".repeat(200) }), item("second", { snippet: "b".repeat(200) })],
  }, DEFAULT_WEIGHTS);
  const packed = packBudget(fused, [], 70);
  assert.deepEqual(packed.included.map((i) => i.key), ["first"]);
  assert.equal(packed.dropped_count, 1);
  assert.equal(packed.dropped[0].key, "second");
});

test("an empty everything is a valid, empty pack", () => {
  const packed = packBudget([], [], 1000);
  assert.deepEqual(packed.included, []);
  assert.equal(packed.tokens, 0);
  assert.equal(packed.over_budget, false);
});
