process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { operations, findOperation, operationsFor } from "../src/operations.js";

const { pool, initDb } = await import("../src/db.js");
const { buildMcpServer } = await import("../src/mcpServer.js");
const { createServer } = await import("../src/http.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { requireBrowserEnabled } = await import("../src/browser/ops.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "bsm_ops_fixture";
const PROFILE = JSON.stringify({
  profile_id: "staging-admin", environment: "staging",
  base_url: "https://staging.example.test", allowed_origins: ["https://staging.example.test"],
  auth: { mode: "saved_state" },
  verify: { url: "https://staging.example.test/admin", selector: "#bar" },
});

let project;
before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  project = await createTestProject(PROJECT);
  await importProfile(PROJECT, PROFILE);
});
beforeEach(async () => {
  await pool.query(`DELETE FROM browser_audit_events WHERE project_id = $1`, [project.id]);
});
after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("browser_profile_list is registered once, read-only, on MCP and CLI but not HTTP (AC-011, Q-008)", () => {
  const op = findOperation("browser_profile_list");
  assert.ok(op);
  assert.equal(op.readOnly, true);
  assert.deepEqual(op.surfaces, ["mcp", "cli"]);
  assert.ok(operationsFor("mcp").includes(op));
  assert.ok(operationsFor("cli").includes(op));
  assert.ok(!operationsFor("http").includes(op));
  // a normal operation is on every surface
  assert.ok(operationsFor("http").includes(findOperation("search_code")));
});

test("no operation can create, replace or remove a profile (REQ-002)", () => {
  const offenders = operations
    .filter((op) => /profile/.test(op.name) && op.name !== "browser_profile_list")
    .map((op) => op.name);
  assert.deepEqual(offenders, []);
  assert.equal(findOperation("browser-profile"), null);
});

test("handler returns the REQ-003 list and writes nothing to audit", async () => {
  const op = findOperation("browser_profile_list");
  const out = await op.handler({ project: PROJECT }, { log() {}, surface: "mcp", correlationId: "c1" });
  assert.equal(out.length, 1);
  assert.equal(out[0].profile_id, "staging-admin");
  assert.equal(out[0].has_saved_state, false);
});

test("unknown project is a rejection carrying project_not_found", async () => {
  const op = findOperation("browser_profile_list");
  await assert.rejects(op.handler({ project: "bsm_nope" }, { log() {} }), (e) => e.code === "project_not_found");
});

test("kill switch: requireBrowserEnabled refuses with browser_disabled", () => {
  requireBrowserEnabled(true);
  assert.throws(() => requireBrowserEnabled(false), (e) => e.code === "browser_disabled");
});

async function connect(surface) {
  const server = buildMcpServer(surface ? { surface } : undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("the stdio/MCP server exposes the tool with readOnlyHint and returns the list", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "browser_profile_list");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  const res = await client.callTool({ name: "browser_profile_list", arguments: { project: PROJECT } });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed[0].profile_id, "staging-admin");
  // AC-002: nothing but the declared fields, nowhere in the raw MCP JSON
  assert.doesNotMatch(res.content[0].text, /selector|secret|state_path|cookie|definition/i);
  await client.close();
});

test("an MCP rejection is isError text starting with its code", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "browser_profile_list", arguments: { project: "bsm_nope" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Error: project_not_found/);
  await client.close();
});

test("a server built for the http surface does not register browser tools", async () => {
  const client = await connect("http");
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name.startsWith("browser_")));
  assert.ok(tools.some((t) => t.name === "search_code"));
  await client.close();
});

test("handlers get surface and a correlation id from the MCP server", async () => {
  const op = findOperation("browser_profile_list");
  const original = op.handler;
  let seen;
  op.handler = (a, ctx) => { seen = ctx; return original(a, ctx); };
  try {
    const client = await connect();
    await client.callTool({ name: "browser_profile_list", arguments: { project: PROJECT } });
    assert.equal(seen.surface, "mcp");
    assert.match(seen.correlationId, /^[0-9a-f-]{36}$/);
    await client.close();
  } finally {
    op.handler = original;
  }
});

// --- HTTP: Q-008 A ---------------------------------------------------------

let server;
let base;
async function startHttp() {
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const stopHttp = () => new Promise((r) => server.close(r));

test("HTTP /v1/ops refuses a browser operation with 403 surface_not_allowed", async () => {
  await startHttp();
  try {
    const res = await fetch(`${base}/v1/ops/browser_profile_list`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "surface_not_allowed");
    assert.doesNotMatch(JSON.stringify(body), /staging-admin/);
  } finally {
    await stopHttp();
  }
});

test("HTTP catalogue, /health count and /mcp tool list leave browser operations out", async () => {
  await startHttp();
  try {
    const { operations: cat } = await (await fetch(`${base}/v1/ops`)).json();
    assert.ok(!cat.some((o) => o.name.startsWith("browser_")));
    assert.equal(cat.length, operationsFor("http").length);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.operations, operationsFor("http").length);
  } finally {
    await stopHttp();
  }
});
