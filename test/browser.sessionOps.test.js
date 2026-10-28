process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findOperation, operationsFor } from "../src/operations.js";

const { pool, initDb } = await import("../src/db.js");
const { buildMcpServer } = await import("../src/mcpServer.js");
const { createServer } = await import("../src/http.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { setSessionManager, shutdownBrowserSessions } = await import("../src/browser/ops.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { createFakeAdapter } = await import("../src/browser/fakeAdapter.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "bsm_sops_a";
const OTHER = "bsm_sops_b";
const ORIGIN = "https://staging.example.test";
const PASS = "sentinel-ops-pass-5e9a";
const PROFILE = {
  profile_id: "staging-admin", environment: "staging", base_url: ORIGIN, allowed_origins: [ORIGIN],
  auth: { mode: "fresh_login", save_state: false },
  login: {
    url: `${ORIGIN}/login`, username_selector: "#u", password_selector: "#p", submit_selector: "#s",
    username_secret: "FAKE_OPS_USER", password_secret: "FAKE_OPS_PASS",
  },
  verify: { url: `${ORIGIN}/admin`, selector: "#bar" },
};

let adapter, stateDir;
before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  await createTestProject(PROJECT);
  await createTestProject(OTHER);
  await importProfile(PROJECT, PROFILE);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-ops-"));
  adapter = createFakeAdapter({ pages: { [`${ORIGIN}/admin`]: { selectors: { "#bar": "x" } } } });
  setSessionManager(createSessionManager({ adapter, stateDir, idleTimeoutMs: 60_000 }));
  process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_OPS_USER = "fake-ops-user";
  process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_OPS_PASS = PASS;
});
after(async () => {
  await shutdownBrowserSessions();
  setSessionManager(null);
  delete process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_OPS_USER;
  delete process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_OPS_PASS;
  clearSensitive();
  fs.rmSync(stateDir, { recursive: true, force: true });
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  await pool.end();
});

async function connect() {
  const server = buildMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: res.content[0].text };
};

test("AC-011: the session tools are registered once with the spec readOnly flags, MCP and CLI only", () => {
  const expected = { browser_session_start: false, browser_session_status: true, browser_session_close: false };
  for (const [name, readOnly] of Object.entries(expected)) {
    const op = findOperation(name);
    assert.ok(op, name);
    assert.equal(op.readOnly, readOnly, name);
    assert.deepEqual(op.surfaces, ["mcp", "cli"]);
    assert.ok(!operationsFor("http").includes(op));
  }
});

test("MCP lifecycle: start -> status -> close, results carry no secret", async () => {
  const client = await connect();
  try {
    const started = await call(client, "browser_session_start", { project: PROJECT, profile_id: "staging-admin", purpose: "ops test" });
    const s = JSON.parse(started.text);
    assert.equal(s.status, "READY");
    assert.deepEqual(s.identity, { verified: true });
    const st = JSON.parse((await call(client, "browser_session_status", { project: PROJECT, session_id: s.session_id })).text);
    assert.equal(st.status, "READY");
    assert.ok(st.created_at && st.expires_at);
    const closed = JSON.parse((await call(client, "browser_session_close", { project: PROJECT, session_id: s.session_id })).text);
    assert.deepEqual(closed, { session_id: s.session_id, status: "CLOSED" });
    assert.ok(!started.text.includes(PASS));
  } finally {
    await client.close();
  }
});

test("MCP: auth_mode mismatch and other-project access are isError with their codes", async () => {
  const client = await connect();
  try {
    const bad = await call(client, "browser_session_start", { project: PROJECT, profile_id: "staging-admin", purpose: "x", auth_mode: "saved_state" });
    assert.equal(bad.res.isError, true);
    assert.match(bad.text, /^Error: auth_mode_mismatch/);
    const s = JSON.parse((await call(client, "browser_session_start", { project: PROJECT, profile_id: "staging-admin", purpose: "x" })).text);
    const cross = await call(client, "browser_session_status", { project: OTHER, session_id: s.session_id });
    assert.equal(cross.res.isError, true);
    assert.match(cross.text, /^Error: session_not_found/);
    await call(client, "browser_session_close", { project: PROJECT, session_id: s.session_id });
  } finally {
    await client.close();
  }
});

test("BROWSER_ENABLED=0 makes all three refuse with browser_disabled", async () => {
  const { config } = await import("../src/config.js");
  const prev = config.browserEnabled;
  config.browserEnabled = false;
  try {
    for (const [name, args] of [
      ["browser_session_start", { project: PROJECT, profile_id: "staging-admin", purpose: "x" }],
      ["browser_session_status", { project: PROJECT, session_id: "bs_x" }],
      ["browser_session_close", { project: PROJECT, session_id: "bs_x" }],
    ]) {
      await assert.rejects(findOperation(name).handler(args, { log() {}, surface: "mcp" }), (e) => e.code === "browser_disabled");
    }
  } finally {
    config.browserEnabled = prev;
  }
});

test("HTTP /v1/ops refuses the session operations with 403", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/ops/browser_session_start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, profile_id: "staging-admin", purpose: "x" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("an unexpected error message is redacted at the op boundary", async () => {
  const { registerSensitive } = await import("../src/browser/secrets.js");
  registerSensitive("leaky-value-123");
  setSessionManager({ start: async () => { throw new Error("boom leaky-value-123"); } });
  try {
    await assert.rejects(
      findOperation("browser_session_start").handler({ project: PROJECT, profile_id: "p", purpose: "x" }, { log() {}, surface: "mcp" }),
      (e) => !e.message.includes("leaky-value-123") && /\[REDACTED\]/.test(e.message)
    );
  } finally {
    setSessionManager(createSessionManager({ adapter, stateDir, idleTimeoutMs: 60_000 }));
  }
});

test("profile removal hook is registered by ops.js", async () => {
  const { removeProfile } = await import("../src/browser/profileStore.js");
  await importProfile(PROJECT, { ...PROFILE, profile_id: "temp" });
  const client = await connect();
  const s = JSON.parse((await call(client, "browser_session_start", { project: PROJECT, profile_id: "temp", purpose: "x" })).text);
  assert.equal(s.status, "READY");
  await removeProfile(PROJECT, "temp", { ctx: { surface: "cli" } });
  assert.equal(adapter.openSessionCount(), 0);
  const st = JSON.parse((await call(client, "browser_session_status", { project: PROJECT, session_id: s.session_id })).text);
  assert.equal(st.status, "CLOSED");
  await client.close();
});
