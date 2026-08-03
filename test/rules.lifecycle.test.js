// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { getRules, setRuleState, listCandidates } = await import("../src/knowledge/rules.js");
const { addScopedRule } = await import("./helpers/rulesFixture.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "rules_lifecycle_fixture";
let root;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rules-"));
  fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/payments"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/payments/api.js"), "export function charge() {}\n");
  fs.writeFileSync(
    path.join(root, "docs/adr/0001-idempotency.md"),
    "---\nstatus: accepted\n---\n# Idempotency keys\n## Context\nRetries double-charged customers.\n" +
      "## Decision\nEvery call to the payment API must carry an idempotency key.\n" +
      "## Consequences\nCallers should reuse the key across retries.\n"
  );
  await indexProject(PROJECT, root);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (root) fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

test("indexing proposes candidates from an ADR decision", async () => {
  const candidates = await listCandidates(PROJECT);
  const idempotency = candidates.find((c) => /idempotency key/i.test(c.statement));
  assert.ok(idempotency, `no idempotency candidate in ${JSON.stringify(candidates, null, 1)}`);
  assert.ok(["adr", "doc"].includes(idempotency.origin), idempotency.origin);
  assert.ok(idempotency.confidence >= 0.6);
});

test("candidates are never returned as rules", async () => {
  const { rules } = await getRules(PROJECT);
  assert.equal(rules.length, 0, "nothing is active yet");
});

test("re-indexing neither duplicates nor resets state", async () => {
  const before_ = await listCandidates(PROJECT);
  const target = before_.find((c) => /idempotency key/i.test(c.statement));
  await setRuleState(PROJECT, target.key, "active", "trac");

  await indexProject(PROJECT, root);

  const after_ = await listCandidates(PROJECT);
  assert.equal(after_.length, before_.length - 1, "the confirmed rule left the queue");
  assert.equal(after_.some((c) => c.key === target.key), false);

  const { rules } = await getRules(PROJECT);
  const confirmed = rules.find((r) => r.key === target.key);
  assert.ok(confirmed, "and stayed active across re-extraction");
  assert.equal(confirmed.verified_by, "trac");
});

test("a rejected rule is not resurrected by re-extraction", async () => {
  const [candidate] = await listCandidates(PROJECT);
  assert.ok(candidate, "fixture has at least one remaining candidate");
  await setRuleState(PROJECT, candidate.key, "rejected", "trac");

  await indexProject(PROJECT, root);

  assert.equal(
    (await listCandidates(PROJECT)).some((c) => c.key === candidate.key),
    false,
    "not back in the queue"
  );
  const { rules } = await getRules(PROJECT);
  assert.equal(rules.some((r) => r.key === candidate.key), false, "and not active either");
});

test("scope filters which rules apply to a target", async () => {
  await addScopedRule(PROJECT, "Never log full card numbers", "src/payments/**");
  await addScopedRule(PROJECT, "Always run the linter", null);

  const scoped = await getRules(PROJECT, "src/payments/api.js");
  const statements = scoped.rules.map((r) => r.statement);
  assert.ok(statements.includes("Never log full card numbers"), "glob matched");
  assert.ok(statements.includes("Always run the linter"), "project-wide rules always apply");

  const elsewhere = await getRules(PROJECT, "docs/adr/0001-idempotency.md");
  assert.ok(!elsewhere.rules.some((r) => r.statement === "Never log full card numbers"));
  assert.ok(elsewhere.rules.some((r) => r.statement === "Always run the linter"));
});
