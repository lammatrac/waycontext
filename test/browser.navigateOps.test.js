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
const { importProfile } = await import("../src/browser/profileStore.js");
const { setSessionManager, shutdownBrowserSessions } = await import("../src/browser/ops.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { createFakeAdapter } = await import("../src/browser/fakeAdapter.js");
const { listArtifacts, resolveStorageRef } = await import("../src/browser/stateStore.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "bsm_nav_a";
const OTHER = "bsm_nav_b";
const ORIGIN = "https://staging.example.test";
const FOREIGN = "https://evil.example.test";
const PASS = "sentinel-nav-pass-77c1";
const PROFILE = {
  profile_id: "staging-admin", environment: "staging", base_url: ORIGIN, allowed_origins: [ORIGIN],
  auth: { mode: "fresh_login", save_state: false },
  login: {
    url: `${ORIGIN}/login`, username_selector: "#u", password_selector: "#p", submit_selector: "#s",
    username_secret: "FAKE_NAV_USER", password_secret: "FAKE_NAV_PASS",
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-nav-"));
  adapter = createFakeAdapter({
    pages: {
      [`${ORIGIN}/admin`]: { selectors: { "#bar": "x" } },
      [`${ORIGIN}/ok`]: {},
      [`${ORIGIN}/to-login`]: { redirect: `${ORIGIN}/login` },
      [`${ORIGIN}/api`]: { status: 401 },
      [`${ORIGIN}/to-foreign`]: { redirect: `${FOREIGN}/x` },
    },
  });
  setSessionManager(createSessionManager({ adapter, stateDir, idleTimeoutMs: 60_000 }));
  process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_NAV_USER = "fake-nav-user";
  process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_NAV_PASS = PASS;
});
after(async () => {
  await shutdownBrowserSessions();
  setSessionManager(null);
  delete process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_NAV_USER;
  delete process.env.WAYCONTEXT_BROWSER_SECRET_FAKE_NAV_PASS;
  clearSensitive();
  fs.rmSync(stateDir, { recursive: true, force: true });
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  await pool.end();
});

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ surface: "mcp" }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return client;
}
const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: res.content[0].text };
};
const startSession = async (client) =>
  JSON.parse((await call(client, "browser_session_start", { project: PROJECT, profile_id: "staging-admin", purpose: "nav test" })).text).session_id;
const auditRows = async (sid) =>
  (await pool.query("SELECT event_type, result, data FROM browser_audit_events WHERE session_id = $1 ORDER BY id", [sid])).rows;

test("AC-011: navigate and screenshot are registered, non-readOnly, MCP and CLI only", () => {
  for (const name of ["browser_navigate", "browser_capture_screenshot"]) {
    const op = findOperation(name);
    assert.ok(op, name);
    assert.equal(op.readOnly, false);
    assert.deepEqual(op.surfaces, ["mcp", "cli"]);
    assert.ok(!operationsFor("http").includes(op));
  }
});

test("navigate to an allowed page returns final_url, http_status, status READY", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    const r = JSON.parse((await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url: `${ORIGIN}/ok` })).text);
    assert.deepEqual(r, { final_url: `${ORIGIN}/ok`, http_status: 200, status: "READY" });
    const rows = await auditRows(sid);
    assert.ok(rows.some((x) => x.event_type === "tool_call" && x.data.tool === "browser_navigate" && x.result === "ok"));
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});

test("navigate to a foreign origin is origin_blocked, audited, and the session stays READY (AC-007)", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    for (const url of [`${FOREIGN}/x`, `${ORIGIN}/to-foreign`]) {
      const r = await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url });
      assert.equal(r.res.isError, true);
      assert.match(r.text, /origin_blocked/);
    }
    const st = JSON.parse((await call(client, "browser_session_status", { project: PROJECT, session_id: sid })).text);
    assert.equal(st.status, "READY");
    assert.ok((await auditRows(sid)).some((x) => x.event_type === "origin_blocked" && x.result === "blocked"));
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});

test("a login redirect or a 401 expires the session (READY -> EXPIRED)", async () => {
  const client = await connect();
  try {
    for (const url of [`${ORIGIN}/to-login`, `${ORIGIN}/api`]) {
      const sid = await startSession(client);
      const r = JSON.parse((await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url })).text);
      assert.equal(r.status, "EXPIRED");
      assert.equal(r.reason, "state_expired");
      const st = JSON.parse((await call(client, "browser_session_status", { project: PROJECT, session_id: sid })).text);
      assert.equal(st.status, "EXPIRED");
      const again = await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url: `${ORIGIN}/ok` });
      assert.equal(again.res.isError, true);
      assert.match(again.text, /session_not_ready/);
    }
  } finally { await client.close(); }
});

test("screenshot stores a 0600 PNG under the state dir, records an artifact row, returns no bytes", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url: `${ORIGIN}/ok` });
    const out = await call(client, "browser_capture_screenshot", { project: PROJECT, session_id: sid });
    const r = JSON.parse(out.text);
    assert.deepEqual(Object.keys(r).sort(), ["captured_at", "height", "path", "storage_ref", "width"]);
    assert.ok(r.path.startsWith(stateDir));
    assert.match(path.basename(r.path), /^screenshot-[A-Za-z0-9.-]+\.png$/);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
    assert.deepEqual([...fs.readFileSync(r.path).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(r.width, 1);
    assert.equal(r.height, 1);
    assert.ok(!out.text.includes("iVBOR"));
    assert.equal(resolveStorageRef(r.storage_ref, { baseDir: stateDir }), r.path);
    const arts = await listArtifacts(sid);
    assert.equal(arts.length, 1);
    assert.equal(arts[0].artifact_type, "screenshot");
    assert.equal(arts[0].storage_ref, r.storage_ref);
    const full = JSON.parse((await call(client, "browser_capture_screenshot", { project: PROJECT, session_id: sid, full_page: true })).text);
    assert.notEqual(full.path, r.path);
    assert.equal([...adapter.sessions].at(-1).calls.at(-1)[0], "screenshot");
    assert.deepEqual([...adapter.sessions].at(-1).calls.at(-1)[1], { fullPage: true });
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});

test("a session id from another project is session_not_found for both ops", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    for (const [name, extra] of [["browser_navigate", { url: `${ORIGIN}/ok` }], ["browser_capture_screenshot", {}]]) {
      const r = await call(client, name, { project: OTHER, session_id: sid, ...extra });
      assert.equal(r.res.isError, true);
      assert.match(r.text, /session_not_found/);
    }
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});

test("the kill switch refuses both ops", async () => {
  const { browserNavigateOp, browserCaptureScreenshotOp } = await import("../src/browser/ops.js");
  const { config } = await import("../src/config.js");
  const prev = config.browserEnabled;
  config.browserEnabled = false;
  try {
    await assert.rejects(browserNavigateOp({ project: PROJECT, session_id: "x", url: ORIGIN }, { surface: "mcp" }), (e) => e.code === "browser_disabled");
    await assert.rejects(browserCaptureScreenshotOp({ project: PROJECT, session_id: "x" }, { surface: "mcp" }), (e) => e.code === "browser_disabled");
  } finally { config.browserEnabled = prev; }
});

test("AC-005: no secret value appears in navigate/screenshot results, errors, DB rows or audit rows", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    const texts = [];
    for (const [name, args] of [
      ["browser_navigate", { url: `${ORIGIN}/ok?token=${PASS}` }],
      ["browser_navigate", { url: `${FOREIGN}/x?token=${PASS}` }],
      ["browser_navigate", { url: `${ORIGIN}/to-foreign` }],
      ["browser_capture_screenshot", {}],
    ]) texts.push((await call(client, name, { project: PROJECT, session_id: sid, ...args })).text);
    const proj = (await pool.query("SELECT id FROM projects WHERE name = $1", [PROJECT])).rows[0];
    const dump = JSON.stringify({
      texts,
      artifacts: (await pool.query("SELECT * FROM browser_session_artifacts WHERE session_id = $1", [sid])).rows,
      audit: (await pool.query("SELECT * FROM browser_audit_events WHERE project_id = $1", [proj.id])).rows,
    });
    assert.ok(!dump.includes(PASS), "the password leaked");
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});

test("navigate to a page that only shares a prefix with the login path (/login-success) stays READY", async () => {
  const client = await connect();
  try {
    const sid = await startSession(client);
    const r = JSON.parse((await call(client, "browser_navigate", { project: PROJECT, session_id: sid, url: `${ORIGIN}/login-success` })).text);
    assert.deepEqual(r, { final_url: `${ORIGIN}/login-success`, http_status: 200, status: "READY" });
    await call(client, "browser_session_close", { project: PROJECT, session_id: sid });
  } finally { await client.close(); }
});
