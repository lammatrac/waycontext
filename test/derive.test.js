// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { embeddingsEnabled } = await import("../src/embeddings.js");
const { watermarkFor } = await import("../src/knowledge/derive.js");
const {
  getModules, getModule, getCochange, getBugClusters,
} = await import("../src/knowledge/architecture.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const {
  createGitRepo, writeRepoFile, commitAll, cleanupGitRepo,
} = await import("./helpers/gitFixture.js");

const PROJECT = "derive_fixture";
let repo;
let firstRun;

before(async () => {
  assert.equal(embeddingsEnabled(), false, "this suite must not make embedding API calls");
  await initDb();
  await cleanupTestProject(PROJECT);
  repo = createGitRepo();

  // src/payments/api.js and its test always move together; src/web is a
  // separate module that depends on payments.
  writeRepoFile(repo, "src/payments/api.js", "export function charge(amount) { return amount; }\n");
  writeRepoFile(repo, "test/payments.test.js", "import { charge } from '../src/payments/api.js';\n");
  writeRepoFile(repo, "src/web/handler.js",
    "import { charge } from '../payments/api.js';\nexport function post() { return charge(1); }\n");
  writeRepoFile(repo, "README.md", "# Fixture\n");
  commitAll(repo, "first: initial payments module");

  writeRepoFile(repo, "src/payments/api.js",
    "export function charge(amount) { return amount * 2; }\n");
  writeRepoFile(repo, "test/payments.test.js",
    "import { charge } from '../src/payments/api.js';\n// covers doubling\n");
  commitAll(repo, "fix: idempotency key missing when charging on retry");

  writeRepoFile(repo, "src/payments/api.js",
    "export function charge(amount) { return Math.round(amount * 2); }\n");
  writeRepoFile(repo, "test/payments.test.js",
    "import { charge } from '../src/payments/api.js';\n// covers rounding\n");
  commitAll(repo, "fix: idempotency key reused across a retry storm");

  writeRepoFile(repo, "src/web/handler.js",
    "import { charge } from '../payments/api.js';\nexport function post() { return charge(2); }\n");
  commitAll(repo, "feat: pass the real amount through");

  firstRun = await indexProject(PROJECT, repo);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repo) cleanupGitRepo(repo);
  await pool.end();
});

test("indexing derives every kind and records a watermark for each", async () => {
  assert.ok(firstRun.derived, "indexProject reports what it derived");
  assert.deepEqual(Object.keys(firstRun.derived.computed).sort(),
    ["clusters", "cochange", "metrics", "modules", "ownership"]);
  assert.deepEqual(firstRun.derived.skipped, []);
  assert.equal(firstRun.derived.failed, null);

  const state = await pool.query(
    `SELECT kind, input_watermark FROM derived_state ds
       JOIN projects p ON p.id = ds.project_id WHERE p.name = $1`,
    [PROJECT]
  );
  assert.equal(state.rows.length, 5);
  const marks = new Set(state.rows.map((r) => r.input_watermark));
  assert.equal(marks.size, 1, "one watermark, so the kinds always move together");
});

test("modules are the directories, with metrics attached", async () => {
  const { modules, module_depth, risk_basis } = await getModules(PROJECT);
  assert.equal(module_depth, 2);
  const paths = modules.map((m) => m.path).sort();
  assert.deepEqual(paths, [".", "src/payments", "src/web", "test"]);

  const payments = modules.find((m) => m.path === "src/payments");
  assert.equal(payments.file_count, 1);
  assert.ok(payments.commits >= 3, `payments changed in 3 commits, saw ${payments.commits}`);
  assert.equal(payments.fix_commits, 2);
  assert.ok(payments.churn > 0);
  assert.equal(risk_basis, "churn_x_defects", "this fixture has fix commits");
});

test("the module that only ever changed for fixes outranks the one that didn't", async () => {
  const { modules } = await getModules(PROJECT, { sort: "risk" });
  const payments = modules.find((m) => m.path === "src/payments");
  const web = modules.find((m) => m.path === "src/web");
  assert.ok(payments.risk > web.risk, `payments ${payments.risk} vs web ${web.risk}`);
  assert.equal(web.fix_commits, 0);
});

test("module dependencies are lifted from the symbol graph, without self-edges", async () => {
  const web = await getModule(PROJECT, "src/web");
  assert.ok(
    web.depends_on.some((d) => d.path === "src/payments"),
    `src/web imports payments: ${JSON.stringify(web.depends_on)}`
  );
  assert.equal(web.depends_on.some((d) => d.path === "src/web"), false, "no self-dependency");

  const payments = await getModule(PROJECT, "src/payments");
  assert.ok(payments.depended_on_by.some((d) => d.path === "src/web"));
});

test("a module carries its owners and its largest files", async () => {
  const payments = await getModule(PROJECT, "src/payments");
  assert.equal(payments.owners.length, 1);
  assert.equal(payments.owners[0].canonical_email, "test@example.com");
  assert.equal(payments.owners[0].share, 1, "the only author owns all of it");
  assert.deepEqual(payments.largest_files.map((f) => f.path), ["src/payments/api.js"]);
});

test("an unknown module names the ones that exist instead of returning empty", async () => {
  await assert.rejects(() => getModule(PROJECT, "src/nope"), /Known modules:.*src\/payments/s);
});

test("co-change finds the test that moves with the file", async () => {
  const { coupled } = await getCochange(PROJECT, "src/payments/api.js");
  const pair = coupled.find((c) => c.path === "test/payments.test.js");
  assert.ok(pair, `expected the test file: ${JSON.stringify(coupled)}`);
  assert.equal(pair.pair_commits, 3);
  assert.equal(pair.confidence, 1, "it never changed without api.js");
});

test("co-change accepts a symbol name, not just a path", async () => {
  const { target, coupled } = await getCochange(PROJECT, "charge");
  assert.equal(target.kind, "symbol");
  assert.ok(coupled.length, "resolved through the identity plane to its file");
});

test("co-change refuses a target it cannot resolve rather than answering broadly", async () => {
  // An unknown name is rejected by resolveTarget with its own message; an empty
  // target resolves to "the whole project", which is not a thing co-change can
  // compare against, so it is refused here.
  await assert.rejects(
    () => getCochange(PROJECT, "no_such_symbol_anywhere"),
    /No file, symbol or directory named/
  );
  await assert.rejects(() => getCochange(PROJECT, "   "), /needs a file/);
});

test("with embeddings off, clusters are keyword buckets and say so", async () => {
  const { clusters, method } = await getBugClusters(PROJECT);
  assert.equal(method, "terms", "never present a keyword bucket as a semantic cluster");
  const idem = clusters.find((c) => /idempotency/.test(c.label));
  assert.ok(idem, `expected an idempotency cluster: ${JSON.stringify(clusters)}`);
  assert.equal(idem.size, 2, "both idempotency fixes landed together");
  assert.equal(idem.module_path, "src/payments");
  assert.equal(idem.examples.length, 2);
});

test("a second run with nothing changed skips every derivation", async () => {
  const again = await indexProject(PROJECT, repo);
  assert.deepEqual(again.derived.skipped.sort(),
    ["clusters", "cochange", "metrics", "modules", "ownership"]);
  assert.deepEqual(again.derived.computed, {});
});

test("a new commit moves the watermark and everything recomputes", async () => {
  writeRepoFile(repo, "src/payments/refund.js", "export function refund(x) { return x; }\n");
  commitAll(repo, "feat: add refunds");
  const run = await indexProject(PROJECT, repo);

  assert.deepEqual(run.derived.skipped, []);
  const payments = (await getModules(PROJECT)).modules.find((m) => m.path === "src/payments");
  assert.equal(payments.file_count, 2, "the new file joined the existing module");
});

test("a project with no commit sha recomputes every run rather than trusting a stale mark", () => {
  // Without a sha there is nothing cheap to compare, and being wrong here means
  // silently serving stale metrics.
  const a = watermarkFor({ last_indexed_sha: null, indexed_at: new Date(1000) });
  const b = watermarkFor({ last_indexed_sha: null, indexed_at: new Date(2000) });
  assert.notEqual(a, b);
  assert.match(a, /^run:/);

  const sha = watermarkFor({ last_indexed_sha: "abc", last_history_sha: "def" });
  assert.equal(sha, "sha:abc|hist:def");
  assert.equal(sha, watermarkFor({ last_indexed_sha: "abc", last_history_sha: "def" }));
  assert.notEqual(sha, watermarkFor({ last_indexed_sha: "abc", last_history_sha: "zzz" }),
    "history moving on its own still recomputes");
});
