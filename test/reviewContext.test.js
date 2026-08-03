// Embeddings off, src imports dynamic — see test/docs.ingest.test.js.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { remember } = await import("../src/knowledge/memory.js");
const { reviewContext } = await import("../src/knowledge/reviewContext.js");
const { getWorkingTreeChanges } = await import("../src/gitDiff.js");
const { addScopedRule } = await import("./helpers/rulesFixture.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const { createGitRepo, writeRepoFile, commitAll, cleanupGitRepo } =
  await import("./helpers/gitFixture.js");

const PROJECT = "review_context_fixture";
let repo;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repo = createGitRepo();
  writeRepoFile(repo, "src/payments/api.js", "export function charge() {}\n");
  writeRepoFile(repo, "src/other.js", "export function other() {}\n");
  commitAll(repo, "fix: always send an idempotency key when charging");
  await indexProject(PROJECT, repo);
  await addScopedRule(PROJECT, "Never log full card numbers", "src/payments/**");
  await remember(PROJECT, {
    content: "Charging twice in one request trips the gateway's duplicate filter.",
    scope: "src/payments/**",
  });
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repo) cleanupGitRepo(repo);
  await pool.end();
});

test("explicit paths assemble rules, memories and recent fixes", async () => {
  const ctx = await reviewContext(PROJECT, ["src/payments/api.js"]);
  assert.deepEqual(ctx.paths, ["src/payments/api.js"]);
  assert.ok(ctx.rules.some((r) => /card numbers/.test(r.statement)));
  assert.ok(ctx.memories.some((m) => /duplicate filter/.test(m.content)));
  assert.ok(
    ctx.recent_fixes.some((c) => /idempotency key/.test(c.subject)),
    JSON.stringify(ctx.recent_fixes)
  );
});

test("a comma-separated string is accepted, as the CLI passes it", async () => {
  const ctx = await reviewContext(PROJECT, "src/payments/api.js, src/other.js");
  assert.deepEqual(ctx.paths, ["src/payments/api.js", "src/other.js"]);
});

test("out-of-scope paths get no scoped rules", async () => {
  const ctx = await reviewContext(PROJECT, ["src/other.js"]);
  assert.ok(!ctx.rules.some((r) => /card numbers/.test(r.statement)));
  assert.ok(!ctx.memories.some((m) => /duplicate filter/.test(m.content)));
});

test("the working tree is the default path set", async () => {
  writeRepoFile(repo, "src/payments/api.js", "export function charge() { return 1; }\n");
  const changed = await getWorkingTreeChanges(repo);
  assert.ok(changed.includes("src/payments/api.js"), JSON.stringify(changed));

  const ctx = await reviewContext(PROJECT);
  assert.ok(ctx.paths.includes("src/payments/api.js"));
  assert.ok(ctx.rules.some((r) => /card numbers/.test(r.statement)));
});

test("an untracked file counts as changed", async () => {
  writeRepoFile(repo, "src/payments/refund.js", "export function refund() {}\n");
  const changed = await getWorkingTreeChanges(repo);
  assert.ok(changed.includes("src/payments/refund.js"), JSON.stringify(changed));

  // The point of including it: a brand-new file still picks up its rules, even
  // though nothing in the index knows about it yet.
  const ctx = await reviewContext(PROJECT, ["src/payments/refund.js"]);
  assert.ok(ctx.rules.some((r) => /card numbers/.test(r.statement)));
});

test("a non-git directory yields no changes rather than throwing", async () => {
  assert.deepEqual(await getWorkingTreeChanges("/tmp"), []);
});
