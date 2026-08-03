import test from "node:test";
import assert from "node:assert/strict";
import {
  decayWeight, riskScore, riskBasis, computeCochange,
} from "../src/knowledge/metrics.js";

test("decay halves a weight every half-life", () => {
  assert.equal(decayWeight(0, 180), 1);
  assert.ok(Math.abs(decayWeight(180, 180) - 0.5) < 1e-9);
  assert.ok(Math.abs(decayWeight(360, 180) - 0.25) < 1e-9);
  assert.equal(decayWeight(-5, 180), 1, "a future timestamp is not a bonus");
  assert.equal(decayWeight(1000, 0), 1, "a zero half-life means no decay at all");
});

test("risk needs both churn and defects, not either alone", () => {
  const busy = { churn: 1000, defectDensity: 0 };    // changes constantly, never breaks
  const fragile = { churn: 10, defectDensity: 1 };   // breaks every time, barely touched
  const both = { churn: 1000, defectDensity: 0.5 };

  assert.equal(riskScore(busy, 1000, true), 0, "churn alone is busy, not risky");
  assert.ok(riskScore(fragile, 1000, true) < 15, "rarely-touched is not urgent");
  assert.ok(riskScore(both, 1000, true) > 60);
});

test("risk is normalised against the project's own worst module", () => {
  const m = { churn: 50, defectDensity: 1 };
  assert.equal(riskScore(m, 50, true), 100, "the worst module in the project is 100");
  assert.equal(riskScore(m, 200, true), 50);
  assert.equal(riskScore(m, 0, true), 0, "a project with no churn has no risk");
});

test("with no fix commits anywhere, risk falls back to churn and says so", () => {
  // is_fix is keyword-based. A team that never writes "fix" in a subject line
  // would otherwise see every module scored 0, which reads as "nothing is
  // risky" rather than "we cannot tell".
  assert.equal(riskScore({ churn: 100, defectDensity: 0 }, 100, false), 100);
  assert.equal(riskBasis(false), "churn_only");
  assert.equal(riskBasis(true), "churn_x_defects");
});

test("defect density outside 0..1 cannot inflate a score", () => {
  assert.equal(riskScore({ churn: 100, defectDensity: 4 }, 100, true), 100);
  assert.equal(riskScore({ churn: 100, defectDensity: -1 }, 100, true), 0);
});

test("co-change counts pairs and the per-file denominators", () => {
  const { pairs } = computeCochange([
    ["a.js", "b.js"],
    ["a.js", "b.js"],
    ["a.js", "c.js"],
  ], { minPairCommits: 1 });

  const ab = pairs.find((p) => p.a === "a.js" && p.b === "b.js");
  assert.equal(ab.pair, 2);
  assert.equal(ab.aCount, 3, "a.js changed in all three commits");
  assert.equal(ab.bCount, 2);
  assert.equal(ab.confidence, 1, "whenever b.js changed, a.js changed too");
});

test("pairs are sorted and thresholded by how often they co-change", () => {
  const { pairs } = computeCochange([
    ["a.js", "b.js"], ["a.js", "b.js"], ["x.js", "y.js"],
  ], { minPairCommits: 2 });
  assert.equal(pairs.length, 1, "the single-commit pair is below the threshold");
  assert.equal(pairs[0].a, "a.js");
});

test("a commit touching too many files is skipped, counted, and still feeds denominators", () => {
  // A license-header sweep over 300 files contributes 45k pairs that say
  // nothing about coupling: the largest cost and the largest noise source here.
  const sweep = Array.from({ length: 60 }, (_, i) => `f${i}.js`);
  const { pairs, skipped, considered } = computeCochange([
    ["a.js", "b.js"], ["a.js", "b.js"], sweep,
  ], { maxFiles: 50, minPairCommits: 2 });

  assert.equal(skipped, 1);
  assert.equal(considered, 2);
  assert.equal(pairs.length, 1, "no pair came out of the sweep");
  assert.equal(pairs[0].pair, 2);
});

test("the file cap can be switched off", () => {
  const sweep = ["a.js", "b.js", "c.js"];
  const { pairs, skipped } = computeCochange([sweep, sweep], { maxFiles: 0, minPairCommits: 2 });
  assert.equal(skipped, 0);
  assert.equal(pairs.length, 3);
});

test("lift is 1 for independent files and above 1 for coupled ones", () => {
  // 4 commits: a+b together twice, a alone once, b alone once.
  const coupled = computeCochange([
    ["a.js", "b.js"], ["a.js", "b.js"], ["a.js"], ["b.js"],
  ], { minPairCommits: 1 }).pairs[0];
  // P(a&b)=2/4, P(a)=3/4, P(b)=3/4 -> 0.5/0.5625
  assert.ok(Math.abs(coupled.lift - (2 * 4) / (3 * 3)) < 1e-6);
  assert.ok(coupled.lift < 1.2 && coupled.lift > 0.8);
});

test("duplicate paths in one commit do not double-count", () => {
  const { pairs } = computeCochange([["a.js", "a.js", "b.js"]], { minPairCommits: 1 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].pair, 1);
  assert.equal(pairs[0].aCount, 1);
});

test("a single-file commit produces no pair but still counts for that file", () => {
  const { pairs, considered } = computeCochange([["a.js"], ["a.js", "b.js"]], { minPairCommits: 1 });
  assert.equal(considered, 1);
  const [p] = pairs;
  assert.equal(p.aCount, 2, "a.js changed twice");
  assert.equal(p.pair, 1);
  assert.equal(p.confidence, 1, "b.js never changed without a.js");
});
