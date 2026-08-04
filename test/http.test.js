// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { operations } from "../src/operations.js";

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { createServer, serve } = await import("../src/http.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const {
  createGitRepo, writeRepoFile, commitAll, cleanupGitRepo,
} = await import("./helpers/gitFixture.js");

const PROJECT = "http_fixture";
let repo;
let server;
let base;

const get = (p) => fetch(`${base}${p}`);
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repo = createGitRepo();
  writeRepoFile(repo, "src/app.js", "export function boot() { return 1; }\n");
  commitAll(repo, "feat: boot");
  await indexProject(PROJECT, repo);

  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupTestProject(PROJECT);
  if (repo) cleanupGitRepo(repo);
  await pool.end();
});

test("health reports the version and the operation count", async () => {
  const res = await get("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.version);
  assert.ok(body.operations >= 18, `only ${body.operations} operations`);
});

test("the operation catalogue is generated, not hand-listed", async () => {
  const { operations } = await (await get("/v1/ops")).json();
  const { operations: registry } = await import("../src/operations.js");
  assert.equal(operations.length, registry.length);
  const search = operations.find((o) => o.name === "search_code");
  assert.deepEqual(search.args, ["project", "query", "limit"]);
  assert.deepEqual(search.required, ["project", "query"]);
  assert.ok(search.description.length > 20);
});

test("any registry operation can be called by name", async () => {
  const res = await post("/v1/ops/get_file_outline", { project: PROJECT, path: "src/app.js" });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result[0].name, "boot");
});

test("an alias resolves the same as the canonical name", async () => {
  const canonical = await (await post("/v1/ops/get_modules", { project: PROJECT })).json();
  const aliased = await (await post("/v1/ops/modules", { project: PROJECT })).json();
  assert.deepEqual(
    aliased.result.modules.map((m) => m.path),
    canonical.result.modules.map((m) => m.path)
  );
});

test("the registry is the allow-list: human-only commands are not routable", async () => {
  // This is the whole reason /v1/ops dispatches through findOperation rather
  // than through a map of handlers: `rule confirm` is a CLI-only command, so it
  // is structurally absent here, exactly as it is absent from MCP.
  for (const name of ["rule", "serve", "knowledge-import", "setRuleState"]) {
    const res = await post(`/v1/ops/${name}`, { project: PROJECT });
    assert.equal(res.status, 404, `${name} must not be routable`);
  }
});

test("invalid arguments are a 400 that says which argument", async () => {
  const res = await post("/v1/ops/search_code", { project: PROJECT });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Invalid arguments");
  assert.ok(body.issues.some((i) => i.path === "query"), JSON.stringify(body.issues));
});

test("an operation's own error is a 400 with its message, not a 500", async () => {
  const res = await post("/v1/ops/get_file_outline", { project: "nope", path: "x.js" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not found/i);
});

test("the composer is served at its own route", async () => {
  const res = await post("/v1/context", { project: PROJECT, task: "change `boot` in src/app.js" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.project, PROJECT);
  assert.ok(Array.isArray(body.context));
  assert.ok(body.meta.elapsed_ms >= 0);
});

test("markdown format comes back as text, not as a JSON-escaped string", async () => {
  const res = await post("/v1/context", {
    project: PROJECT, task: "change `boot`", format: "markdown",
  });
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.match(await res.text(), /^# Context for: change/);
});

test("the composer requires both project and task", async () => {
  assert.equal((await post("/v1/context", { project: PROJECT })).status, 400);
  assert.equal((await post("/v1/context", { task: "x" })).status, 400);
});

test("a malformed body is rejected without crashing the server", async () => {
  const res = await fetch(`${base}/v1/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/);
  assert.equal((await get("/health")).status, 200, "still alive");
});

/** One JSON-RPC call over the /mcp route, returning the parsed result. */
async function rpc(body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  // StreamableHTTP may answer as SSE: `event: message\ndata: {...}`.
  const payload = text.startsWith("event:") || text.includes("\ndata: ")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("")
    : text;
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: payload ? JSON.parse(payload) : null,
    raw: text,
  };
}

test("MCP over HTTP completes the handshake", async () => {
  // The distribution channel: `claude mcp add --transport http` is a one-liner.
  const res = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.result?.serverInfo, res.raw.slice(0, 300));
  assert.match(res.body.result.serverInfo.name, /waycontext/i);
});

test("MCP over HTTP lists exactly the registry's tools", async () => {
  // This test used to only run `initialize` and grep the response for
  // "serverInfo" -- it never called tools/list, so despite its name it could not
  // have caught the registry and the MCP surface diverging.
  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  const sessionId = init.sessionId;

  if (sessionId) {
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  assert.equal(listed.status, 200, listed.raw.slice(0, 300));
  const names = listed.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, operations.map((op) => op.name).sort());
});

test("every tool exposed over MCP carries a description an LLM can route on", async () => {
  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, init.sessionId);
  const thin = listed.body.result.tools.filter((t) => !t.description || t.description.length < 20);
  assert.deepEqual(thin.map((t) => t.name), []);
});

test("unknown routes list the ones that exist", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.ok((await res.json()).routes.includes("/v1/context"));
});

test("the web UI is served at the root and calls only registry operations", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>WayContext/);

  // The page must not reach for an endpoint that doesn't exist -- it has no build
  // step and no type checking, so this is the only thing standing between a
  // renamed operation and a blank panel.
  const { findOperation } = await import("../src/operations.js");
  const called = [...html.matchAll(/op\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(called.length >= 3, `only found ${called.length} operation calls`);
  for (const name of new Set(called)) {
    assert.ok(findOperation(name), `the web UI calls "${name}", which is not an operation`);
  }
});

test("static paths cannot escape the web directory", async () => {
  // %2e%2e%2f is ../ url-encoded; node's URL parser normalises plain ../ before
  // the handler ever sees it, so the encoded form is the one worth asserting.
  for (const p of ["/%2e%2e%2f%2e%2e%2fpackage.json", "/..%2fpackage.json"]) {
    const res = await get(p);
    assert.ok(res.status === 403 || res.status === 404, `${p} returned ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes("\"dependencies\""), `${p} leaked package.json`);
  }
});

test("binding to a public interface is refused without an explicit opt-in", async () => {
  // An unauthenticated server that reads your source code must not be one config
  // typo away from being on the network.
  await assert.rejects(
    () => serve({ host: "0.0.0.0", port: 0 }),
    /Refusing to bind.*no authentication/s
  );
});
