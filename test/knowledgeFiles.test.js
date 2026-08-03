// Embeddings off, src imports dynamic — see test/docs.ingest.test.js.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";

const { pool, initDb, getOrCreateProject } = await import("../src/db.js");
const { exportKnowledge, importKnowledge } = await import("../src/knowledge/knowledgeFiles.js");
const { getRules, setRuleState, listCandidates } = await import("../src/knowledge/rules.js");
const { addScopedRule } = await import("./helpers/rulesFixture.js");
const { remember, recall } = await import("../src/knowledge/memory.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "knowledge_files_fixture";
let root;
let dir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-yaml-"));
  dir = path.join(root, ".waycontext/knowledge");
  await getOrCreateProject(PROJECT, root);
  await addScopedRule(PROJECT, "Never log full card numbers", "src/payments/**");
  await remember(PROJECT, {
    content: "Gateway rejects duplicate charges.\n\nSecond paragraph: with a colon.\n",
  });
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (root) fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

test("export writes active rules and memories as readable YAML", async () => {
  const result = await exportKnowledge(PROJECT);
  assert.equal(result.rules, 1);
  assert.equal(result.memories, 1);

  const parsed = load(fs.readFileSync(path.join(dir, "rules.yaml"), "utf8"));
  assert.equal(parsed.rules[0].statement, "Never log full card numbers");
  assert.equal(parsed.rules[0].scope, "src/payments/**");
  assert.match(parsed.rules[0].key, /^rule:/);

  const memText = fs.readFileSync(path.join(dir, "memories.yaml"), "utf8");
  assert.match(memText, /\|/, "multi-paragraph content used a block scalar");
  assert.match(load(memText).memories[0].content, /Second paragraph: with a colon/);
});

test("import is idempotent and creates no duplicates", async () => {
  const first = await importKnowledge(PROJECT);
  const second = await importKnowledge(PROJECT);
  assert.deepEqual(first, second);

  const { rules } = await getRules(PROJECT);
  assert.equal(rules.filter((r) => /card numbers/.test(r.statement)).length, 1);
});

test("a hand-written entry with no key imports and gets one", async () => {
  fs.appendFileSync(
    path.join(dir, "rules.yaml"),
    "  - statement: Always pin the migration version\n    severity: high\n"
  );
  await importKnowledge(PROJECT);

  const { rules } = await getRules(PROJECT);
  const added = rules.find((r) => /pin the migration version/.test(r.statement));
  assert.ok(added, "hand-written rule imported");
  assert.equal(added.severity, "high");
  assert.match(added.key, /^rule:[0-9a-f]{12}$/);
});

test("import never deactivates a rule missing from the file", async () => {
  await addScopedRule(PROJECT, "Only in the database, not in YAML", null);
  await importKnowledge(PROJECT);

  const { rules } = await getRules(PROJECT);
  assert.ok(rules.some((r) => /Only in the database/.test(r.statement)), "still active");
});

test("import never downgrades an active rule listed as a candidate", async () => {
  const [active] = (await getRules(PROJECT)).rules;
  fs.writeFileSync(
    path.join(dir, "candidates.yaml"),
    `candidates:\n  - key: ${active.key}\n    statement: ${JSON.stringify(active.statement)}\n` +
      `    scope: ${JSON.stringify(active.scope)}\n`
  );
  await importKnowledge(PROJECT);

  const { rules } = await getRules(PROJECT);
  assert.ok(rules.some((r) => r.key === active.key), "stayed active");
  assert.equal(
    (await listCandidates(PROJECT)).some((c) => c.key === active.key),
    false,
    "and did not reappear in the queue"
  );
});

test("a candidate in YAML imports as a candidate, not as a rule", async () => {
  fs.writeFileSync(
    path.join(dir, "candidates.yaml"),
    "candidates:\n  - statement: Never trust the clock on a laptop\n    confidence: 0.5\n"
  );
  await importKnowledge(PROJECT);

  assert.ok(
    (await listCandidates(PROJECT)).some((c) => /trust the clock/.test(c.statement)),
    "queued for review"
  );
  const { rules } = await getRules(PROJECT);
  assert.equal(rules.some((r) => /trust the clock/.test(r.statement)), false, "not injected");
});

test("imported memories are recallable", async () => {
  await importKnowledge(PROJECT);
  const hits = await recall(PROJECT, "duplicate charges gateway", 5);
  assert.ok(hits.some((h) => /duplicate charges/.test(h.content)));
});

test("importing into a project with no knowledge directory is a no-op", async () => {
  const bare = "knowledge_files_bare";
  await cleanupTestProject(bare);
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-yaml-bare-"));
  await getOrCreateProject(bare, bareRoot);
  try {
    assert.deepEqual(await importKnowledge(bare), {
      rules: 0, candidates: 0, memories: 0, promoted: 0,
    });
  } finally {
    await cleanupTestProject(bare);
    fs.rmSync(bareRoot, { recursive: true, force: true });
  }
});
