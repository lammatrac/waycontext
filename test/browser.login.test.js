process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { operations, findOperation, operationsFor } from "../src/operations.js";

const { pool, initDb } = await import("../src/db.js");
const { buildMcpServer } = await import("../src/mcpServer.js");
const { createServer } = await import("../src/http.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { createFakeAdapter } = await import("../src/browser/fakeAdapter.js");
const { captureLogin } = await import("../src/browser/loginCapture.js");
const { hasSavedState, loadStorageState } = await import("../src/browser/stateStore.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");
const { MANUAL_COMMANDS } = await import("../src/completion.js");

const PROJECT = "bsm_login_fixture";
const ORIGIN = "https://staging.example.test";
const FOREIGN = "https://evil.example.test";
const SAVED = {
  profile_id: "saved-admin", environment: "staging", base_url: ORIGIN, allowed_origins: [ORIGIN],
  auth: { mode: "saved_state" },
  login: {
    url: `${ORIGIN}/login`, username_selector: "#u", password_selector: "#p", submit_selector: "#s",
    username_secret: "FAKE_LOGIN_USER", password_secret: "FAKE_LOGIN_PASS",
  },
  verify: { url: `${ORIGIN}/admin`, selector: "#bar" },
};
const FRESH = { ...SAVED, profile_id: "fresh-admin", auth: { mode: "fresh_login", save_state: true } };

let project, stateDir, ctx;
const scope = () => ({ orgId: undefined, project: PROJECT, profileId: "saved-admin" });
const audit = async () =>
  (await pool.query(`SELECT event_type, actor, result, data FROM browser_audit_events WHERE project_id = $1 ORDER BY id`, [project.id])).rows;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  project = await createTestProject(PROJECT);
  await importProfile(PROJECT, JSON.stringify(SAVED));
  await importProfile(PROJECT, JSON.stringify(FRESH));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-login-"));
});
beforeEach(async () => {
  await pool.query(`DELETE FROM browser_audit_events WHERE project_id = $1`, [project.id]);
  fs.rmSync(path.join(stateDir), { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  ctx = { surface: "cli", correlationId: "11111111-1111-1111-1111-111111111111", log() {} };
});
after(async () => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  await cleanupTestProject(PROJECT);
  await pool.end();
});

const okPages = { [`${ORIGIN}/admin`]: { selectors: { "#bar": "x", "#who": " Admin " } } };
const run = (adapter, extra = {}) =>
  captureLogin({
    project: PROJECT, profileId: "saved-admin", adapter, stateDir, ctx,
    waitForDone: async () => {}, timeoutMs: 1000, verifyWaitMs: 10, ...extra,
  });

test("verification pass saves state at 0600 under the profile id and audits state_save as cli", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  const out = await run(adapter);
  assert.equal(out.profile_id, "saved-admin");
  assert.equal(out.verified, true);
  assert.match(out.storage_ref, /^storage_state:/);
  const { currentOrgId } = await import("../src/db.js");
  const sc = { orgId: await currentOrgId(), project: PROJECT, profileId: "saved-admin" };
  assert.equal(hasSavedState(sc, { baseDir: stateDir }), true);
  assert.deepEqual(Object.keys(loadStorageState(sc, { baseDir: stateDir })).sort(), ["cookies", "origins"]);
  const file = path.join(stateDir, ...out.storage_ref.slice("storage_state:".length).split("/").map(decodeURIComponent));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const rows = await audit();
  assert.ok(rows.every((r) => r.actor === "cli"));
  assert.deepEqual(rows.map((r) => r.event_type), ["manual_login_started", "state_save", "manual_login_finished"]);
  assert.equal(rows[1].data.storage_ref, out.storage_ref);
  assert.equal(rows[2].result, "ok");
  // headed, on the login page, with every adapter session released
  assert.equal(adapter.sessions.size, 0);
});

test("the headed session opens on login.url", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  let seen;
  await run(adapter, { waitForDone: async ({ session }) => { seen = { opts: session.options, calls: [...session.calls] }; } });
  assert.equal(seen.opts.headed, true);
  assert.deepEqual(seen.calls[0], ["goto", `${ORIGIN}/login`]);
});

test("verification failure saves nothing and throws verification_failed", async () => {
  const adapter = createFakeAdapter({ pages: {} }); // no #bar on /admin
  await assert.rejects(run(adapter), (e) => e.code === "verification_failed");
  const { currentOrgId } = await import("../src/db.js");
  assert.equal(hasSavedState({ orgId: await currentOrgId(), project: PROJECT, profileId: "saved-admin" }, { baseDir: stateDir }), false);
  const rows = await audit();
  assert.ok(!rows.some((r) => r.event_type === "state_save"));
  assert.equal(rows.at(-1).event_type, "manual_login_finished");
  assert.equal(rows.at(-1).result, "failed");
  assert.equal(rows.at(-1).data.code, "verification_failed");
  assert.equal(adapter.sessions.size, 0);
});

test("a human who never finishes times out with login_timeout and nothing is saved", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await assert.rejects(
    run(adapter, { timeoutMs: 30, waitForDone: () => new Promise(() => {}) }),
    (e) => e.code === "login_timeout"
  );
  assert.ok(!(await audit()).some((r) => r.event_type === "state_save"));
  assert.equal(adapter.sessions.size, 0);
});

test("closing the browser window before finishing is login_cancelled", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await assert.rejects(
    run(adapter, { waitForDone: ({ session }) => { session.simulateCrash(); return new Promise(() => {}); } }),
    (e) => e.code === "login_cancelled"
  );
  assert.ok(!(await audit()).some((r) => r.event_type === "state_save"));
});

test("a rejected completion signal (EOF / Ctrl-D) is login_cancelled", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await assert.rejects(
    run(adapter, { waitForDone: async () => { const e = new Error("eof"); e.code = "login_cancelled"; throw e; } }),
    (e) => e.code === "login_cancelled"
  );
});

test("a fresh_login profile is refused with auth_mode_mismatch before any browser opens", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await assert.rejects(run(adapter, { profileId: "fresh-admin" }), (e) => e.code === "auth_mode_mismatch");
  assert.equal(adapter.sessions.size, 0);
  const rows = await audit();
  assert.equal(rows.at(-1).result, "rejected");
});

test("unknown profile and unknown project are rejections", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await assert.rejects(run(adapter, { profileId: "nope" }), (e) => e.code === "profile_not_found");
  await assert.rejects(run(adapter, { project: "bsm_nope" }), (e) => e.code === "project_not_found");
});

test("the guard blocks a foreign navigation by the human and audits it; login still completes", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  let blocked;
  await run(adapter, {
    waitForDone: async ({ session }) => {
      blocked = await session.goto(`${FOREIGN}/phish`).catch((e) => e);
    },
  });
  assert.equal(blocked.code, "origin_blocked");
  const rows = await audit();
  const b = rows.find((r) => r.event_type === "origin_blocked");
  assert.ok(b);
  assert.equal(b.actor, "cli");
  assert.equal(b.result, "blocked");
  assert.equal(b.data.origin, FOREIGN);
});

test("a login page that redirects off the allowlist fails with origin_blocked, nothing saved", async () => {
  const adapter = createFakeAdapter({ pages: { [`${ORIGIN}/login`]: { redirect: `${FOREIGN}/x` } } });
  await assert.rejects(run(adapter), (e) => e.code === "origin_blocked");
  assert.ok(!(await audit()).some((r) => r.event_type === "state_save"));
  assert.equal(adapter.sessions.size, 0);
});

test("no secret value or cookie value reaches audit data", async () => {
  const adapter = createFakeAdapter({ pages: okPages });
  await run(adapter);
  assert.doesNotMatch(JSON.stringify(await audit()), /cookie|password|FAKE_LOGIN_PASS/i);
});

// --- human-only: structurally absent from every agent surface ----------------

test("browser-login is not an operation, not in the catalogue, and is a MANUAL_COMMANDS entry", () => {
  assert.equal(findOperation("browser-login"), null);
  assert.equal(findOperation("browser_login"), null);
  assert.ok(!operations.some((op) => /login/i.test(op.name) || (op.cli?.aliases ?? []).some((a) => /login/i.test(a))));
  assert.ok(!operationsFor("mcp").some((op) => /login/i.test(op.name)));
  assert.ok(!operationsFor("http").some((op) => /login/i.test(op.name)));
  assert.ok(MANUAL_COMMANDS.some((c) => c.name === "browser-login"));
});

test("MCP tool list has no login tool", async () => {
  const server = buildMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => /login/i.test(t.name)));
  const res = await client.callTool({ name: "browser-login", arguments: { project: PROJECT, profile_id: "saved-admin" } }).catch((e) => ({ isError: true, e }));
  assert.equal(res.isError, true);
  await client.close();
});

test("HTTP neither lists nor runs browser-login", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/v1/ops`)).text();
    assert.doesNotMatch(list, /login/i);
    const res = await fetch(`${base}/v1/ops/browser-login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: PROJECT }),
    });
    assert.ok(res.status >= 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- the default completion signal: an Enter prompt -------------------------------

test("promptForEnter resolves on a line, and rejects login_cancelled on EOF, even if EOF came first", async () => {
  const { PassThrough } = await import("node:stream");
  const { promptForEnter } = await import("../src/browser/loginCapture.js");
  const quiet = new PassThrough();
  const line = new PassThrough();
  const p1 = promptForEnter({ input: line, output: quiet });
  line.write("\n");
  await p1;

  const eofLater = new PassThrough();
  const p2 = promptForEnter({ input: eofLater, output: quiet });
  eofLater.end();
  await assert.rejects(p2, (e) => e.code === "login_cancelled");

  const eofFirst = new PassThrough();
  eofFirst.end();
  eofFirst.resume();
  await new Promise((r) => setTimeout(r, 20)); // 'end' has been emitted before the prompt attaches
  await assert.rejects(promptForEnter({ input: eofFirst, output: quiet }), (e) => e.code === "login_cancelled");
});

test("a timeout beyond the timer limit (2^31-1 ms) is rejected up front, before any browser opens", async () => {
  const adapter = createFakeAdapter();
  let waited = false;
  await assert.rejects(
    run(adapter, { timeoutMs: 2 ** 31, waitForDone: async () => { waited = true; } }),
    (e) => e.code === "invalid_argument" && /timeout/.test(e.message)
  );
  assert.equal(waited, false);
  assert.equal(adapter.openSessionCount(), 0);
});
