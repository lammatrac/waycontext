// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb } = await import("../src/db.js");
const { embeddingsEnabled } = await import("../src/embeddings.js");
const { indexProject } = await import("../src/indexer.js");
const { composeContext, toMarkdown } = await import("../src/context/compose.js");
const { withDeadline } = await import("../src/context/channels.js");
const { remember } = await import("../src/knowledge/memory.js");
const { addScopedRule } = await import("./helpers/rulesFixture.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const {
  createGitRepo, writeRepoFile, commitAll, cleanupGitRepo,
} = await import("./helpers/gitFixture.js");

const PROJECT = "compose_fixture";
let repo;

before(async () => {
  assert.equal(embeddingsEnabled(), false, "this suite must not make embedding API calls");
  await initDb();
  await cleanupTestProject(PROJECT);
  repo = createGitRepo();

  writeRepoFile(repo, "src/payments/api.js",
    "// charge a customer\nexport function charge(amount) { return amount; }\n");
  writeRepoFile(repo, "src/payments/refund.js",
    "import { charge } from './api.js';\nexport function refund(a) { return charge(-a); }\n");
  writeRepoFile(repo, "docs/adr/0001-idempotency.md",
    "# Idempotency keys\n## Context\nRetries double-charged customers.\n" +
    "## Decision\nEvery call to the payment API must carry an idempotency key.\n");
  commitAll(repo, "feat: payments module");

  writeRepoFile(repo, "src/payments/api.js",
    "// charge a customer\nexport function charge(amount) { return Math.round(amount); }\n");
  commitAll(repo, "fix: charge rounded the amount the wrong way on retry");

  await indexProject(PROJECT, repo);
  await addScopedRule(PROJECT, "Never log full card numbers", "src/payments/**");
  await remember(PROJECT, {
    content: "The payment API rejects a repeated idempotency key with 409, not 200.",
    kind: "gotcha",
    scope: "src/payments/**",
  });
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repo) cleanupGitRepo(repo);
  await pool.end();
});

test("a plain-language task is understood as the symbols and paths it names", async () => {
  const r = await composeContext(PROJECT, "fix the retry bug in `charge` in src/payments");
  assert.ok(r.understood.symbols.some((s) => s.startsWith("charge ")), r.understood.symbols.join(","));
  assert.ok(r.understood.paths.includes("src/payments/api.js"), r.understood.paths.join(","));
});

test("scoped rules for the paths involved are included and pinned", async () => {
  const r = await composeContext(PROJECT, "change `charge` in src/payments/api.js");
  const rule = r.context.find((i) => i.type === "rule");
  assert.ok(rule, JSON.stringify(r.context.map((i) => i.type)));
  assert.equal(rule.title, "Never log full card numbers");
  assert.equal(rule.pinned, true);
  assert.equal(r.meta.rules_included, 1);
});

test("a rule out of scope for the task is not injected", async () => {
  // Injecting a payments rule into a docs task is the failure mode that makes an
  // agent worse, not better.
  const r = await composeContext(PROJECT, "update docs/adr/0001-idempotency.md wording");
  assert.equal(r.context.some((i) => i.title === "Never log full card numbers"), false);
});

test("past fixes to the named file come back with their sha as the citation", async () => {
  const r = await composeContext(PROJECT, "look at src/payments/api.js retry handling");
  const commit = r.context.find((i) => i.type === "commit");
  assert.ok(commit, "expected a commit");
  assert.match(commit.title, /rounded the amount/);
  assert.match(commit.ref, /^[0-9a-f]{7,}$/);
});

test("every item carries a citation", async () => {
  const r = await composeContext(PROJECT, "fix `charge` rounding in src/payments/api.js");
  assert.ok(r.context.length >= 3, `only ${r.context.length} items`);
  for (const item of r.context) {
    assert.ok(item.ref, `no ref on ${JSON.stringify(item)}`);
    assert.ok(item.why, `no explanation on ${JSON.stringify(item)}`);
  }
});

test("the graph channel reaches code the task never named", async () => {
  // refund() calls charge(). A task about charge() should surface refund without
  // the task text mentioning it -- the step a pure vector search cannot take.
  const r = await composeContext(PROJECT, "change the signature of `charge`");
  assert.ok(
    r.context.some((i) => i.title === "refund" || /refund/.test(i.ref ?? "")),
    JSON.stringify(r.context.map((i) => `${i.type}:${i.title}`))
  );
});

test("a budget too small for even one item still keeps the rules", async () => {
  // Budget 1: nothing fits, including the rules. They go in anyway and the
  // overspend is reported, because an agent that never saw a constraint breaks
  // it confidently, while a missing snippet only makes it search again.
  const r = await composeContext(PROJECT, "change `charge` in src/payments/api.js", { budget: 1 });
  assert.equal(r.context.every((i) => i.type === "rule"), true,
    JSON.stringify(r.context.map((i) => i.type)));
  assert.equal(r.meta.rules_included, 1);
  assert.equal(r.meta.over_budget, true);
  assert.ok(r.meta.dropped_count > 0);
});

test("a budget that fits the rules and little else drops the expensive items first", async () => {
  const r = await composeContext(PROJECT, "change `charge` in src/payments/api.js", { budget: 40 });
  assert.ok(r.context.some((i) => i.type === "rule"));
  assert.equal(r.context.some((i) => i.snippet), false, "nothing carrying a body survived");
  assert.ok(r.meta.dropped_count > 0);
  assert.ok(r.meta.used_tokens <= 40 || r.meta.over_budget);
});

test("paths the project does not have are reported rather than swallowed", async () => {
  const r = await composeContext(PROJECT, "fix `notARealSymbol` in src/billing/ledger.js");
  assert.ok(r.understood.unresolved.paths.includes("src/billing/ledger.js"));
  assert.ok(r.understood.unresolved.identifiers.includes("notARealSymbol"));
});

test("snippets can be withheld while citations remain", async () => {
  // What makes a privacy tier possible later: paths, names and citations without
  // bodies. Exercised now so the path doesn't rot.
  const r = await composeContext(PROJECT, "fix `charge` in src/payments/api.js", { snippets: false });
  assert.ok(r.context.length > 0);
  assert.equal(r.context.every((i) => i.snippet === null), true);
  assert.equal(r.context.every((i) => i.ref), true);
});

test("markdown is paste-ready and leads with the rules", async () => {
  const md = await composeContext(PROJECT, "change `charge` in src/payments/api.js", {
    format: "markdown",
  });
  assert.equal(typeof md, "string");
  assert.match(md, /^# Context for: change/);
  const rulesAt = md.indexOf("## Rules you must follow");
  const codeAt = md.indexOf("## Relevant code");
  assert.ok(rulesAt >= 0, md.slice(0, 400));
  if (codeAt >= 0) assert.ok(rulesAt < codeAt, "rules come first");
  assert.match(md, /tokens · \d+ ms/);
});

test("an empty task is refused rather than answered vaguely", async () => {
  await assert.rejects(() => composeContext(PROJECT, "  "), /task description is required/);
  await assert.rejects(() => composeContext("no_such_project", "x"), /not found/);
});

test("a channel that misses its deadline is named, not silently omitted", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
  const raced = await withDeadline(slow, 10, "slowpoke");
  assert.equal(raced.timedOut, true);
  assert.equal(raced.value, null);

  const quick = await withDeadline(Promise.resolve("fast"), 200, "quick");
  assert.deepEqual(quick, { name: "quick", timedOut: false, value: "fast" });

  const failed = await withDeadline(Promise.reject(new Error("nope")), 200, "broken");
  assert.equal(failed.error, "nope");
  assert.equal(failed.value, null);
});

test("a whole-project task still returns unscoped context rather than nothing", async () => {
  const r = await composeContext(PROJECT, "understand how this project handles retries");
  assert.ok(r.context.length > 0);
  assert.deepEqual(r.understood.unresolved, { paths: [], identifiers: [] });
});

test("markdown of an empty result is still valid markdown", () => {
  const md = toMarkdown({
    task: "nothing", understood: { paths: [], symbols: [], unresolved: { paths: [], identifiers: [] } },
    context: [],
    meta: { used_tokens: 0, budget_tokens: 100, elapsed_ms: 1, dropped_count: 0, degraded_channels: [] },
  });
  assert.match(md, /^# Context for: nothing/);
  assert.match(md, /0\/100 tokens/);
});
