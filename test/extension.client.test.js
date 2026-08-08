// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The extension is CommonJS, as VS Code extensions are. client.js is the half
// with no `require("vscode")` in it, which is exactly why it can be tested here.
const { WayContextClient, WayContextError } = require("../extension/client.js");

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { createServer } = await import("../src/http.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const {
  createGitRepo, writeRepoFile, commitAll, cleanupGitRepo,
} = await import("./helpers/gitFixture.js");

const PROJECT = "extension_fixture";
let repo, server, api;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repo = createGitRepo();
  writeRepoFile(repo, "src/payments/api.js", "export function charge(a) { return a; }\n");
  writeRepoFile(repo, "src/web/handler.js", "export function post() { return 1; }\n");
  commitAll(repo, "feat: init");
  await indexProject(PROJECT, repo);

  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = new WayContextClient(`http://127.0.0.1:${server.address().port}`);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupTestProject(PROJECT);
  if (repo) cleanupGitRepo(repo);
  await pool.end();
});

test("health round-trips through the client", async () => {
  const h = await api.health();
  assert.equal(h.ok, true);
  assert.ok(h.operations >= 18);
});

test("a trailing slash in the configured URL doesn't produce a double slash", async () => {
  const sloppy = new WayContextClient(`${api.baseUrl}///`);
  assert.equal((await sloppy.health()).ok, true);
});

test("operations are called through the registry, by name", async () => {
  const outline = await api.op("get_file_outline", { project: PROJECT, path: "src/payments/api.js" });
  assert.equal(outline[0].name, "charge");
});

test("a project is found from an absolute path inside its root", async () => {
  assert.equal(await api.projectForPath(`${repo}/src/payments/api.js`), PROJECT);
  assert.equal(await api.projectForPath("/somewhere/else/x.js"), null);
});

test("the longest matching project root wins", async () => {
  // A project indexed at a subdirectory of another must not lose to its parent
  // just because the parent was listed first.
  const NESTED = "extension_fixture_nested";
  try {
    await cleanupTestProject(NESTED);
    await indexProject(NESTED, `${repo}/src/payments`);
    assert.equal(await api.projectForPath(`${repo}/src/payments/api.js`), NESTED);
    assert.equal(await api.projectForPath(`${repo}/src/web/handler.js`), PROJECT);
  } finally {
    await cleanupTestProject(NESTED);
  }
});

test("the module for a file comes from the server, not a second copy of the rule", async () => {
  const mod = await api.moduleForPath(PROJECT, "src/payments/api.js");
  assert.equal(mod.path, "src/payments");
  const nested = await api.moduleForPath(PROJECT, "src/web/handler.js");
  assert.equal(nested.path, "src/web");
});

test("a file in no module returns null rather than a wrong module", async () => {
  // There is no "." module here, because this fixture has no file at its root --
  // modules are derived from indexed files, not from the shape of the tree. So
  // an unindexed path matches nothing, and the caller shows "no module covers
  // this file" instead of being handed a plausible-looking wrong answer.
  assert.equal(await api.moduleForPath(PROJECT, "unindexed/elsewhere.js"), null);
});

test("where a root module does exist, it covers files nothing else claims", async () => {
  const ROOTED = "extension_fixture_rooted";
  try {
    await cleanupTestProject(ROOTED);
    const dir = createGitRepo();
    writeRepoFile(dir, "index.js", "export const x = 1;\n");
    writeRepoFile(dir, "src/deep/thing.js", "export const y = 2;\n");
    commitAll(dir, "feat: init");
    try {
      await indexProject(ROOTED, dir);
      assert.equal((await api.moduleForPath(ROOTED, "index.js"))?.path, ".");
      assert.equal((await api.moduleForPath(ROOTED, "src/deep/thing.js"))?.path, "src/deep");
    } finally {
      cleanupGitRepo(dir);
    }
  } finally {
    await cleanupTestProject(ROOTED);
  }
});

test("compose_context comes back as markdown text", async () => {
  const md = await api.composeContext(PROJECT, "change `charge` in src/payments/api.js");
  assert.match(md, /^# Context for: change/);
});

test("an unknown operation is an operation error, not a crash", async () => {
  await assert.rejects(
    () => api.op("not_an_operation", { project: PROJECT }),
    (e) => e instanceof WayContextError && e.kind === "operation" && /Unknown operation/.test(e.message)
  );
});

test("a validation failure names the offending argument", async () => {
  await assert.rejects(
    () => api.op("search_code", { project: PROJECT }),
    (e) => e.kind === "operation" && /query/.test(e.message)
  );
});

test("a stopped server is reported as offline, with the command that fixes it", async () => {
  // The overwhelmingly common failure, and the one with a one-line fix. Telling
  // someone "fetch failed" instead would waste the interaction.
  const dead = new WayContextClient("http://127.0.0.1:1");
  for (const call of [() => dead.health(), () => dead.op("list_projects", {})]) {
    await assert.rejects(call, (e) =>
      e instanceof WayContextError && e.kind === "offline" && /waycontext service ensure/.test(e.message));
  }
});

test("the extension registers exactly the commands its manifest declares", () => {
  // The one thing worth asserting about extension.js without a headless VS Code:
  // that the manifest and the code agree. They are edited separately and drift
  // silently -- a command in the palette that throws "command not found".
  const manifest = require("../extension/package.json");
  const declared = manifest.contributes.commands
    .map((c) => c.command.replace(/^waycontext\./, ""))
    .sort();

  // extension.js requires "vscode", which does not exist outside the host, so the
  // command names are read from the source rather than by importing it.
  const fs = require("node:fs");
  const source = fs.readFileSync(new URL("../extension/extension.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const commands = {"), source.indexOf("function activate"));
  const implemented = [...block.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]).sort();

  assert.deepEqual(implemented, declared);
});
