// Embeddings off, src imports dynamic: static ESM imports are hoisted above
// this assignment. See test/docs.ingest.test.js for the same precaution.
process.env.EMBEDDING_PROVIDER = "none";
// The config routes write to this file, never to the developer's real config.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wc-http-config-"));
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
process.env.WAYCONTEXT_CONFIG = CONFIG_FILE;

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { operations, operationsFor } from "../src/operations.js";

const { pool, initDb } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { createServer, serve } = await import("../src/http.js");
const { createReasoningGraph } = await import("../src/reasoning/store.js");
const { config } = await import("../src/config.js");
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
  // Browser operations are MCP/CLI only (Q-008), so the HTTP catalogue is the
  // registry minus them -- see test/browser.operations.test.js.
  assert.equal(operations.length, operationsFor("http").length);
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
  for (const name of ["rule", "serve", "service", "knowledge-import", "setRuleState"]) {
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
  assert.deepEqual(names, operationsFor("http").map((op) => op.name).sort());
  assert.ok(!names.some((n) => n.startsWith("browser_")), "browser tools must not be served on /mcp over HTTP");
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

test("reasoning review pages are served by project and slug", async () => {
  const prevAutoOpen = config.reasoningAutoOpen;
  const prevAutoService = config.serviceAutoStart;
  try {
    config.reasoningAutoOpen = false;
    config.serviceAutoStart = false;

    await createReasoningGraph(PROJECT, { feature: "HTTP review", slug: "http-review" });

    const res = await get(`/reviews/${PROJECT}/http-review`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /HTTP review/);
  } finally {
    config.reasoningAutoOpen = prevAutoOpen;
    config.serviceAutoStart = prevAutoService;
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

// --- write protection on non-GET routes ------------------------------------

/** Raw request, because fetch refuses to let a caller set Host. */
function rawRequest({ method = "POST", path: p, headers = {}, body = "{}", port }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const opsPost = (headers) => fetch(`${base}/v1/ops/list_projects`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}",
});

test("write protection: foreign Origin refused", async () => {
  const res = await opsPost({ Origin: "http://evil.example" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "forbidden_origin");
});

test("write protection: wrong Host refused", async () => {
  const port = server.address().port;
  const status = await rawRequest({
    path: "/v1/ops/list_projects", port,
    headers: { Host: `evil.example:${port}`, "Content-Type": "application/json" },
  });
  assert.equal(status, 403);
});

test("write protection: non-JSON content type refused", async () => {
  const res = await fetch(`${base}/v1/ops/list_projects`, {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
  });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).code, "unsupported_media_type");
});

test("write protection: same-origin allowed", async () => {
  assert.equal((await opsPost({ Origin: base })).status, 200);
});

test("write protection: no Origin allowed (MCP and extension clients)", async () => {
  assert.equal((await post("/v1/ops/list_projects", {})).status, 200);
});

test("write protection: /mcp also guarded", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("write protection: media type is case-insensitive and tolerates parameters", async () => {
  const res = await opsPost({ "Content-Type": "Application/JSON; charset=utf-8" });
  assert.equal(res.status, 200);
});

test("write protection: bodiless DELETE /mcp is not refused as unsupported media type", async () => {
  const port = server.address().port;
  const status = await rawRequest({ method: "DELETE", path: "/mcp", port, body: undefined });
  assert.notEqual(status, 415);
  assert.notEqual(status, 403);
});

test("write protection: public bind skips only the Host check", async () => {
  const pub = createServer({ publicBind: true });
  await new Promise((resolve) => pub.listen(0, "127.0.0.1", resolve));
  const port = pub.address().port;
  try {
    const wrongHost = await rawRequest({
      path: "/v1/ops/list_projects", port,
      headers: { Host: "wlx.example.com", "Content-Type": "application/json" },
    });
    assert.notEqual(wrongHost, 403);
    const foreignOrigin = await rawRequest({
      path: "/v1/ops/list_projects", port,
      headers: { Host: "wlx.example.com", Origin: "http://evil.example", "Content-Type": "application/json" },
    });
    assert.equal(foreignOrigin, 403, "Origin still enforced");
    const text = await rawRequest({
      path: "/v1/ops/list_projects", port,
      headers: { Host: "wlx.example.com", "Content-Type": "text/plain" },
    });
    assert.equal(text, 415, "Content-Type still enforced");
  } finally {
    await new Promise((resolve) => pub.close(resolve));
  }
});

const put = (p, body, headers = { "Content-Type": "application/json" }) =>
  fetch(`${base}${p}`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("GET /v1/config returns the settings report with service and file metadata", async () => {
  const res = await get("/v1/config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.settings.length >= 40, `only ${body.settings.length} settings`);
  assert.ok(!Number.isNaN(Date.parse(body.serviceStartedAt)));
  assert.equal(body.configFile, CONFIG_FILE);
  assert.ok(Array.isArray(body.projectOverrides));
  assert.ok("configMtime" in body);
});

test("PUT /v1/config writes the file and returns the fresh report", async () => {
  const res = await put("/v1/config", { set: { ORG_SLUG: "zz" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(fs.readFileSync(CONFIG_FILE, "utf8").includes('"zz"'));
  assert.equal(body.settings.find((s) => s.key === "ORG_SLUG").fileValue, "zz");
  assert.ok(body.configMtime, "mtime is set once the file exists");

  const cleared = await put("/v1/config", { unset: ["ORG_SLUG"] });
  assert.equal(cleared.status, 200);
  assert.ok(!fs.readFileSync(CONFIG_FILE, "utf8").includes('"zz"'));
});

test("/v1/config does not depend on Postgres: GET and PUT are 200 with projectsError", async () => {
  const srv = createServer({ listProjects: async () => { throw new Error("db is down"); } });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const got = await fetch(`${url}/v1/config`);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.deepEqual(body.projectOverrides, []);
    assert.equal(body.projectsError, "db is down");

    const put = await fetch(`${url}/v1/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set: { ORG_SLUG: "dbdown" } }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).projectsError, "db is down");
    assert.ok(fs.readFileSync(CONFIG_FILE, "utf8").includes('"dbdown"'), "the file was written");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(CONFIG_FILE, { force: true });
  }
});

test("PUT /v1/config refuses secrets with 403 and the offending key", async () => {
  const res = await put("/v1/config", { set: { DATABASE_URL: "postgres://x" } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.key, "DATABASE_URL");
  assert.ok(body.error);
});

test("PUT /v1/config without a JSON content type is 415", async () => {
  const res = await put("/v1/config", "{}", { "Content-Type": "text/plain" });
  assert.equal(res.status, 415);
});

test("PUT /v1/config maps a non-ConfigWriteError failure to 500", async () => {
  // A directory where the file should be makes the read fail with EISDIR.
  const dir = path.join(CONFIG_DIR, "as-dir");
  fs.mkdirSync(dir);
  const prev = process.env.WAYCONTEXT_CONFIG;
  process.env.WAYCONTEXT_CONFIG = dir;
  try {
    const res = await put("/v1/config", { set: { ORG_SLUG: "zz" } });
    assert.equal(res.status, 500);
    assert.ok((await res.json()).error);
  } finally {
    process.env.WAYCONTEXT_CONFIG = prev;
  }
});

test("GET /v1/integrations returns the five items", async () => {
  const res = await get("/v1/integrations");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.items.map((i) => i.id),
    ["mcp_registration", "gate_script", "gate_hooks", "config_file", "service"],
  );
});

async function withRestartServer(fn) {
  const calls = [];
  const srv = createServer({ onRestart: () => calls.push(1) });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const restart = () =>
    fetch(`${url}/v1/service/restart`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
  try {
    await fn({ url, restart, calls });
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

async function withInjected(value, fn) {
  const prev = process.env.WAYCONTEXT_SERVICE_INJECTED;
  if (value === undefined) delete process.env.WAYCONTEXT_SERVICE_INJECTED;
  else process.env.WAYCONTEXT_SERVICE_INJECTED = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.WAYCONTEXT_SERVICE_INJECTED;
    else process.env.WAYCONTEXT_SERVICE_INJECTED = prev;
  }
}

test("POST /v1/service/restart is 409 when not under the managed service", async () => {
  await withInjected(undefined, () => withRestartServer(async ({ restart, calls }) => {
    const res = await restart();
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "not running under the managed service");
    assert.equal(calls.length, 0);
  }));
});

test("POST /v1/service/restart is 202 under the managed service and schedules the exit", async () => {
  await withInjected("WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT", () =>
    withRestartServer(async ({ restart, calls }) => {
      const res = await restart();
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { restarting: true });
      assert.equal(calls.length, 1);
    }));
});

test("POST /v1/service/restart is 409 with a distinct error while an index is in flight", async () => {
  await withInjected("WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT", () =>
    withRestartServer(async ({ url, restart, calls }) => {
      const indexing = fetch(`${url}/v1/ops/index_project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: PROJECT, path: repo }),
      });
      // Early polls can land before the index request is counted and get a 202
      // (the stub absorbs the exit); keep polling until the refusal appears.
      let seen = null;
      let exitsAtRefusal = null;
      for (let i = 0; i < 200 && !seen; i++) {
        const before = calls.length;
        const res = await restart();
        if (res.status === 409) {
          const { error } = await res.json();
          if (/index/i.test(error)) {
            seen = error;
            exitsAtRefusal = before;
          }
        }
      }
      await (await indexing).text();
      assert.ok(seen, "restart was refused because an index was running");
      assert.notEqual(seen, "not running under the managed service");
      assert.equal(calls.length, exitsAtRefusal, "the refused restart scheduled no exit");

      // The counter came back down, so restart is allowed again.
      const after = await restart();
      assert.equal(after.status, 202);
      assert.equal(calls.length, exitsAtRefusal + 1);
    }));
});

test("POST /v1/service/restart is refused while an index started outside /v1/ops runs", async () => {
  // The count lives on the operation handler, which /mcp calls too.
  const { findOperation } = await import("../src/operations.js");
  await withInjected("WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT", () =>
    withRestartServer(async ({ restart, calls }) => {
      const indexing = findOperation("index_project").handler(
        { project: PROJECT, path: repo }, { log: () => {}, surface: "mcp" },
      );
      const res = await restart();
      await indexing;
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /index/i);
      assert.equal(calls.length, 0);
      assert.equal((await restart()).status, 202, "counter decremented");
    }));
});
