import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, cosine, greedyCluster, topTerms, documentFrequencies, bucketTerm,
} from "../src/knowledge/clusters.js";

test("commit-message noise words are not clustering signal", () => {
  // Without this, every cluster in a repo that uses conventional commits is
  // labelled "fix".
  assert.deepEqual(tokenize("fix: the bug in cache purge"), ["cache", "purge"]);
  assert.deepEqual(tokenize("chore: bump 1234"), ["bump"]);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize("a an it"), [], "sub-3-character words go too");
});

test("cosine does not assume unit vectors", () => {
  assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-12, "same direction, different length");
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.equal(cosine([0, 0], [1, 1]), 0, "a zero vector is similar to nothing");
});

test("greedy clustering groups what is close and separates what is not", () => {
  const clusters = greedyCluster([
    [1, 0, 0], [0.99, 0.1, 0], // near-identical
    [0, 1, 0],                 // unrelated
  ], 0.9);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].members, [0, 1]);
  assert.deepEqual(clusters[1].members, [2]);
});

test("a high threshold puts everything in its own cluster", () => {
  const clusters = greedyCluster([[1, 0], [0.9, 0.1], [0, 1]], 0.999);
  assert.equal(clusters.length, 3);
});

test("clustering is deterministic for a given input order", () => {
  const vectors = [[1, 0], [0, 1], [0.95, 0.05], [0.05, 0.95]];
  const a = greedyCluster(vectors, 0.9).map((c) => c.members);
  const b = greedyCluster(vectors, 0.9).map((c) => c.members);
  assert.deepEqual(a, b);
});

test("labels are the terms that distinguish a cluster from the corpus", () => {
  const corpus = [
    tokenize("fix: idempotency key missing on retry"),
    tokenize("fix: idempotency key reused across retries"),
    tokenize("fix: template rendering whitespace"),
  ];
  const label = topTerms(corpus, [0, 1], 2);
  assert.ok(label.includes("idempotency"), label.join(","));
  assert.ok(!label.includes("template"), "a term from outside the cluster is not its label");
});

test("bucketing picks the shared term, not the rare one", () => {
  // The failure this exists to prevent: tf-idf scores the term a commit shares
  // with another commit LOWER than the term unique to it, so using it to choose
  // a bucket splits exactly the commits that belong together.
  const corpus = [
    tokenize("fix: idempotency key missing on webhook retry"),
    tokenize("fix: idempotency key reused during replay"),
  ];
  const docFreq = documentFrequencies(corpus);
  assert.equal(bucketTerm(corpus, 0, docFreq), "idempotency");
  assert.equal(bucketTerm(corpus, 1, docFreq), "idempotency");
  assert.notEqual(
    topTerms(corpus, [0], 1)[0], "idempotency",
    "whereas the labelling function deliberately prefers the distinctive term"
  );
});

test("document frequencies count documents, not occurrences", () => {
  const df = documentFrequencies([["cache", "cache", "purge"], ["cache"]]);
  assert.equal(df.get("cache"), 2);
  assert.equal(df.get("purge"), 1);
});

test("a document with no usable terms buckets nowhere rather than crashing", () => {
  const corpus = [tokenize("fix: a bug")];
  assert.equal(bucketTerm(corpus, 0, documentFrequencies(corpus)), null);
});
