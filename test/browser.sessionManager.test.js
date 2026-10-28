process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb } = await import("../src/db.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { createFakeAdapter } = await import("../src/browser/fakeAdapter.js");
const { importProfile, removeProfile, getProfile } = await import("../src/browser/profileStore.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

const PROJECT = "bsm_mgr_a";
const OTHER = "bsm_mgr_b";
const ORIGIN = "https://staging.example.test";
const FOREIGN = "https://evil.example.test";
const SECRET_USER = "FAKE_MGR_USER";
const SECRET_PASS = "FAKE_MGR_PASS";
const PASS_VALUE = "sentinel-pass-d41d8cd9";
const USER_VALUE = "sentinel-user-98f00b20";

const profile = (over = {}) => ({
  profile_id: "staging-admin", environment: "staging", base_url: ORIGIN, allowed_origins: [ORIGIN],
  auth: { mode: "fresh_login", save_state: true },
  login: {
    url: `${ORIGIN}/login`, url_pattern: "/login",
    username_selector: "#user", password_selector: "#pass", submit_selector: "#submit",
    username_secret: SECRET_USER, password_secret: SECRET_PASS,
  },
  verify: { url: `${ORIGIN}/admin`, selector: "#bar", text: "Dashboard", identity_selector: "#me" },
  ...over,
});
const savedProfile = () => profile({ profile_id: "saved", auth: { mode: "saved_state" } });

const GOOD_PAGES = {
  [`${ORIGIN}/login`]: { selectors: { "#user": "", "#pass": "", "#submit": "" } },
  [`${ORIGIN}/admin`]: { selectors: { "#bar": "bar", "#me": "Administrator" }, text: "Dashboard" },
};

let projectA, projectB, stateDir, adapter, mgr, logs, audits;
const ctx = (extra = {}) => ({ log: (m) => logs.push(m), surface: "mcp", correlationId: "corr-1", ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(10); }
  return false;
}
const rows = async (sql, p) => (await pool.query(sql, p)).rows;
const eventsFor = (sid) => rows(`SELECT * FROM browser_audit_events WHERE session_id = $1 ORDER BY id`, [sid]);

function make(over = {}) {
  adapter = createFakeAdapter({ pages: structuredClone(GOOD_PAGES) });
  const launches = { n: 0 };
  const orig = adapter.createSession.bind(adapter);
  adapter.createSession = (o) => { launches.n++; return orig(o); };
  adapter.launches = launches;
  mgr = createSessionManager({
    adapter, stateDir, idleTimeoutMs: 60_000, hostname: "h1", pid: 111, bootId: "boot-A",
    isPidAlive: () => true, ...over,
  });
  return mgr;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  projectA = await createTestProject(PROJECT);
  projectB = await createTestProject(OTHER);
  await importProfile(PROJECT, profile());
  await importProfile(PROJECT, savedProfile());
});
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-mgr-"));
  logs = [];
  process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_USER}`] = USER_VALUE;
  process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_PASS}`] = PASS_VALUE;
  make();
});
afterEach(async () => {
  await mgr.shutdown({ ctx: ctx() });
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_USER}`];
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_PASS}`];
  clearSensitive();
});
after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  await pool.end();
});

const start = (over = {}, c = ctx()) =>
  mgr.start({ project: PROJECT, profileId: "staging-admin", purpose: "unit test", ctx: c, ...over });

// ---- REQ-009/010/011: fresh_login ---------------------------------------------------

test("fresh_login reaches READY, types secrets via the adapter and saves state at 0600", async () => {
  const r = await start();
  assert.equal(r.status, "READY");
  assert.equal(r.auth_mode, "fresh_login");
  assert.equal(r.environment, "staging");
  assert.deepEqual(r.identity, { verified: true, role: "Administrator" });
  assert.ok(r.session_id && r.last_verified_at);
  assert.equal(r.reason, undefined);

  const typed = adapter.sessions.values().next().value.calls.filter((c) => c[0] === "fill");
  assert.deepEqual(typed, [["fill", "#user", USER_VALUE], ["fill", "#pass", PASS_VALUE]]);

  const art = await rows(`SELECT * FROM browser_session_artifacts WHERE session_id = $1`, [r.session_id]);
  assert.equal(art.length, 1);
  assert.equal(art[0].artifact_type, "storage_state");
  const file = path.join(stateDir, ...art[0].storage_ref.replace(/^storage_state:/, "").split("/"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("every lifecycle transition and the state save are audited, with actor and correlation id", async () => {
  const r = await start();
  const ev = await eventsFor(r.session_id);
  const moves = ev.filter((e) => e.event_type === "session_transition").map((e) => `${e.data.from ?? "-"}>${e.data.to}`);
  assert.deepEqual(moves, ["-:>CREATED".replace(":", ""), "CREATED>STARTING", "STARTING>AUTHENTICATING", "AUTHENTICATING>VERIFYING", "VERIFYING>READY"]);
  assert.ok(ev.some((e) => e.event_type === "state_save" && e.result === "ok"));
  assert.ok(ev.some((e) => e.event_type === "tool_call" && e.data.tool === "browser_session_start"));
  assert.ok(ev.every((e) => e.actor === "mcp" && e.correlation_id === "corr-1"));
});

test("an unset secret returns FAILED/secret_missing and launches no browser (AC-003)", async () => {
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_PASS}`];
  const r = await start();
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "secret_missing");
  assert.equal(adapter.launches.n, 0);
  assert.deepEqual(r.identity, { verified: false });
});

test("a wrong password (verification page not reached) is FAILED/verification_failed and saves nothing", async () => {
  adapter.pages[`${ORIGIN}/admin`] = { redirect: `${ORIGIN}/login` };
  const r = await start();
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "verification_failed");
  assert.equal(adapter.openSessionCount(), 0);
  assert.deepEqual(await rows(`SELECT 1 FROM browser_session_artifacts WHERE session_id = $1`, [r.session_id]), []);
});

test("a login page served with HTTP 200 still fails verification via login_url_pattern", async () => {
  adapter.pages[`${ORIGIN}/admin`] = { redirect: `${ORIGIN}/login` };
  adapter.pages[`${ORIGIN}/login`] = { status: 200, selectors: { "#user": "", "#pass": "", "#submit": "", "#bar": "bar" }, text: "Dashboard" };
  const r = await start();
  assert.equal(r.reason, "verification_failed");
});

test("verify status >= 400 or a missing required text fails verification", async () => {
  adapter.pages[`${ORIGIN}/admin`] = { status: 403, selectors: { "#bar": "x" }, text: "Dashboard" };
  assert.equal((await start()).reason, "verification_failed");
  adapter.pages[`${ORIGIN}/admin`] = { selectors: { "#bar": "x" }, text: "Nope" };
  assert.equal((await start()).reason, "verification_failed");
});

test("identity.role is omitted when the identity assertion does not match", async () => {
  adapter.pages[`${ORIGIN}/admin`] = { selectors: { "#bar": "x" }, text: "Dashboard" };
  const r = await start();
  assert.equal(r.status, "READY");
  assert.deepEqual(r.identity, { verified: true });
});

test("a disallowed redirect during login is FAILED/login_failed, no state saved, block audited (REQ-015)", async () => {
  adapter.pages[`${ORIGIN}/login`] = { redirect: `${FOREIGN}/phish` };
  const r = await start();
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "login_failed");
  assert.equal(adapter.openSessionCount(), 0);
  const ev = await eventsFor(r.session_id);
  const blocked = ev.filter((e) => e.event_type === "origin_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].result, "blocked");
  assert.equal(blocked[0].data.kind, "redirect");
  assert.equal(blocked[0].data.url, `${FOREIGN}/phish`);
  assert.deepEqual(await rows(`SELECT 1 FROM browser_session_artifacts WHERE session_id = $1`, [r.session_id]), []);
});

test("a missing login selector is FAILED/login_failed", async () => {
  adapter.pages[`${ORIGIN}/login`] = { selectors: {} };
  const orig = adapter.createSession.bind(adapter);
  adapter.createSession = async (o) => {
    const s = await orig(o);
    s.fill = async () => { throw new (await import("../src/browser/errors.js")).BrowserError("runtime_launch_failed", "timeout waiting for selector"); };
    return s;
  };
  const r = await start();
  assert.equal(r.reason, "login_failed");
});

test("runtime_unavailable on launch is FAILED/runtime_unavailable", async () => {
  adapter.failNextLaunch("runtime_unavailable");
  const r = await start();
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "runtime_unavailable");
});

test("runtime_launch_failed on launch is FAILED/runtime_lost", async () => {
  adapter.failNextLaunch("runtime_launch_failed");
  assert.equal((await start()).reason, "runtime_lost");
});

// ---- saved_state --------------------------------------------------------------------

async function seedState(profileId = "saved") {
  const { saveStorageState } = await import("../src/browser/stateStore.js");
  const { currentOrgId } = await import("../src/db.js");
  const orgId = await currentOrgId();
  await saveStorageState({ orgId, project: PROJECT, profileId }, { cookies: [{ name: "sid", value: "cookie-sentinel-7c1", domain: "x", path: "/" }], origins: [] }, { baseDir: stateDir });
}

test("saved_state without a stored file is FAILED/state_missing and launches no browser", async () => {
  const r = await start({ profileId: "saved" });
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "state_missing");
  assert.equal(adapter.launches.n, 0);
});

test("saved_state loads the state into the context and reaches READY without secrets", async () => {
  await seedState();
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_PASS}`];
  const r = await start({ profileId: "saved" });
  assert.equal(r.status, "READY");
  assert.equal(r.auth_mode, "saved_state");
  assert.equal(adapter.sessions.values().next().value.options.storageState.cookies[0].name, "sid");
});

test("saved_state whose verification fails is EXPIRED/state_expired; state is kept and the runtime released (REQ-012)", async () => {
  await seedState();
  adapter.pages[`${ORIGIN}/admin`] = { redirect: `${ORIGIN}/login` };
  const r = await start({ profileId: "saved" });
  assert.equal(r.status, "EXPIRED");
  assert.equal(r.reason, "state_expired");
  assert.equal(adapter.openSessionCount(), 0);
  const { hasSavedState } = await import("../src/browser/stateStore.js");
  const { currentOrgId } = await import("../src/db.js");
  assert.equal(hasSavedState({ orgId: await currentOrgId(), project: PROJECT, profileId: "saved" }, { baseDir: stateDir }), true);
});

// ---- rejections ---------------------------------------------------------------------

test("start rejects unknown project/profile, a mismatching auth_mode and production", async () => {
  await assert.rejects(start({ project: "bsm_nope" }), (e) => e.code === "project_not_found");
  await assert.rejects(start({ profileId: "nope" }), (e) => e.code === "profile_not_found");
  await assert.rejects(start({ authMode: "saved_state" }), (e) => e.code === "auth_mode_mismatch");
  // a stored row that somehow says production is still refused at start
  await pool.query(`UPDATE browser_profiles SET environment = 'production' WHERE project_id = $1 AND profile_id = 'saved'`, [projectA.id]);
  try {
    await assert.rejects(start({ profileId: "saved" }), (e) => e.code === "environment_not_allowed");
  } finally {
    await pool.query(`UPDATE browser_profiles SET environment = 'staging' WHERE project_id = $1 AND profile_id = 'saved'`, [projectA.id]);
  }
  assert.equal(adapter.launches.n, 0);
});

test("a state directory inside the project root is refused and the session does not become READY", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-root-"));
  try {
    await pool.query(`UPDATE projects SET root_path = $2 WHERE id = $1`, [projectA.id, root]);
    const inside = path.join(root, "state");
    fs.mkdirSync(inside);
    make({ stateDir: inside });
    await assert.rejects(start(), (e) => e.code === "invalid_state_dir");
    const row = (await rows(`SELECT status FROM browser_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, [projectA.id]))[0];
    assert.equal(row.status, "FAILED");
    assert.equal(adapter.openSessionCount(), 0);
  } finally {
    await pool.query(`UPDATE projects SET root_path = $2 WHERE id = $1`, [projectA.id, `/tmp/${PROJECT}`]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- status / close / isolation -----------------------------------------------------

test("status returns the REQ-013 object and a session of another project is session_not_found (AC-006)", async () => {
  const { session_id } = await start();
  const s = await mgr.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "READY");
  assert.ok(s.created_at && s.expires_at);
  assert.equal(s.environment, "staging");
  await assert.rejects(mgr.status({ project: OTHER, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_found");
  await assert.rejects(mgr.close({ project: OTHER, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_found");
  await assert.rejects(mgr.status({ project: PROJECT, sessionId: "bs_unknown", ctx: ctx() }), (e) => e.code === "session_not_found");
  assert.equal(adapter.openSessionCount(), 1);
  const rejected = await rows(`SELECT 1 FROM browser_audit_events WHERE project_id = $1 AND result = 'rejected'`, [projectB.id]);
  assert.ok(rejected.length >= 2, "rejected calls are audited under the caller's project");
});

test("close releases resources, sets CLOSED, and is idempotent (AC-009)", async () => {
  const { session_id } = await start();
  assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() }), { session_id, status: "CLOSED" });
  assert.equal(adapter.openSessionCount(), 0);
  assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() }), { session_id, status: "CLOSED" });
  const row = (await rows(`SELECT status, closed_at FROM browser_sessions WHERE id = $1`, [session_id]))[0];
  assert.equal(row.status, "CLOSED");
  assert.ok(row.closed_at);
});

test("two sessions on one profile get separate contexts (AC-006)", async () => {
  await start();
  await start();
  const [a, b] = [...adapter.sessions];
  assert.notEqual(a, b);
  assert.equal(adapter.openSessionCount(), 2);
});

// ---- ownership / liveness -----------------------------------------------------------

test("a crashed runtime makes the next status FAILED/runtime_lost, never READY (AC-008)", async () => {
  const { session_id } = await start();
  [...adapter.sessions][0].simulateCrash();
  const s = await mgr.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "FAILED");
  assert.equal(s.reason, "runtime_lost");
  const ev = await eventsFor(session_id);
  assert.ok(ev.some((e) => e.event_type === "session_transition" && e.data.to === "FAILED" && e.data.reason === "runtime_lost"));
});

test("a runtime that reports not-alive is FAILED/runtime_lost on status even before onClosed fires", async () => {
  const { session_id } = await start();
  [...adapter.sessions][0].isAlive = () => false;
  assert.equal((await mgr.status({ project: PROJECT, sessionId: session_id, ctx: ctx() })).reason, "runtime_lost");
});

test("a row owned by a dead pid on this host is FAILED/runtime_lost (AC-008)", async () => {
  const { session_id } = await start();
  const other = make({ pid: 222, bootId: "boot-B", isPidAlive: (pid) => pid !== 111 });
  const s = await other.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "FAILED");
  assert.equal(s.reason, "runtime_lost");
});

test("a row owned by a live pid in another process is session_not_in_this_process and left untouched", async () => {
  const { session_id } = await start();
  const other = createSessionManager({ adapter: createFakeAdapter(), stateDir, hostname: "h1", pid: 222, bootId: "boot-B", isPidAlive: () => true });
  await assert.rejects(other.status({ project: PROJECT, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_in_this_process");
  await assert.rejects(other.close({ project: PROJECT, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_in_this_process");
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [session_id]))[0].status, "READY");
});

test("a row owned by another host is session_not_in_this_process until its lease (expires_at) lapses, then runtime_lost", async () => {
  const { session_id } = await start();
  const remote = createSessionManager({ adapter: createFakeAdapter(), stateDir, hostname: "h2", pid: 5, bootId: "boot-C", isPidAlive: () => false });
  await assert.rejects(remote.status({ project: PROJECT, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_in_this_process");
  await pool.query(`UPDATE browser_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [session_id]);
  const s = await remote.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "FAILED");
  assert.equal(s.reason, "runtime_lost");
});

test("expires_at is last activity + idle timeout and is refreshed by an acquired call", async () => {
  const { session_id } = await start();
  const before1 = (await rows(`SELECT expires_at FROM browser_sessions WHERE id = $1`, [session_id]))[0].expires_at;
  await wait(20);
  await mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "t", ctx: ctx() }, async () => {});
  const after1 = (await rows(`SELECT expires_at FROM browser_sessions WHERE id = $1`, [session_id]))[0].expires_at;
  assert.ok(after1 > before1);
});

// ---- concurrency --------------------------------------------------------------------

test("a second call on a busy session fails fast with session_busy and close does too", async () => {
  const { session_id } = await start();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "a", ctx: ctx() }, () => gate);
  await wait(10);
  await assert.rejects(mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "b", ctx: ctx() }, async () => 1), (e) => e.code === "session_busy");
  await assert.rejects(mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_busy");
  const s = await mgr.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "READY", "status is not a locked operation");
  release();
  await first;
  await mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "c", ctx: ctx() }, async () => 1);
});

test("withSession hands out the runtime and refuses a non-READY session with session_not_ready", async () => {
  const { session_id } = await start();
  const got = await mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "x", ctx: ctx() }, async ({ runtime, profile: p }) => ({ url: await runtime.url(), pid: p.profile_id }));
  assert.equal(got.pid, "staging-admin");
  await mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  await assert.rejects(mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "x", ctx: ctx() }, async () => 1), (e) => e.code === "session_not_ready");
  await assert.rejects(mgr.withSession({ project: OTHER, sessionId: session_id, tool: "x", ctx: ctx() }, async () => 1), (e) => e.code === "session_not_found");
});

test("idle timeout closes an unused session with reason idle_timeout (AC-009)", async () => {
  make({ idleTimeoutMs: 60 });
  const { session_id } = await start();
  assert.ok(await until(async () => (await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [session_id]))[0].status === "CLOSED"));
  const row = (await rows(`SELECT status, reason FROM browser_sessions WHERE id = $1`, [session_id]))[0];
  assert.equal(row.reason, "idle_timeout");
  assert.equal(adapter.openSessionCount(), 0);
});

test("idle timeout does not tear a session down while a call is in flight, and re-arms after it", async () => {
  make({ idleTimeoutMs: 60 });
  const { session_id } = await start();
  let sawAlive = null;
  await mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "slow", ctx: ctx() }, async ({ runtime }) => {
    await wait(200);
    sawAlive = runtime.isAlive();
    await runtime.url();
  });
  assert.equal(sawAlive, true);
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [session_id]))[0].status, "READY");
  assert.ok(await until(async () => (await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [session_id]))[0].status === "CLOSED"));
});

test("P5 helper: expire() moves a READY session to EXPIRED/state_expired and releases the runtime", async () => {
  const { session_id } = await start();
  await mgr.withSession({ project: PROJECT, sessionId: session_id, tool: "navigate", ctx: ctx() }, async (h) => { await h.expire(); });
  const s = await mgr.status({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  assert.equal(s.status, "EXPIRED");
  assert.equal(s.reason, "state_expired");
  assert.equal(adapter.openSessionCount(), 0);
  // EXPIRED can still be closed
  assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() }), { session_id, status: "CLOSED" });
});

// ---- shutdown / profile removal -----------------------------------------------------

test("shutdown closes every live session (process_shutdown) and the adapter", async () => {
  const a = await start();
  const b = await start();
  await mgr.shutdown({ ctx: ctx() });
  assert.equal(adapter.openSessionCount(), 0);
  for (const id of [a.session_id, b.session_id]) {
    const row = (await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [id]))[0];
    assert.equal(row.status, "CLOSED");
    const ev = (await eventsFor(id)).find((e) => e.event_type === "session_closed");
    assert.equal(ev.data.cause, "process_shutdown");
  }
});

test("closeProfileSessions tears down this process's runtimes for a profile (removal hook)", async () => {
  const a = await start();
  await mgr.closeProfileSessions({ projectId: projectA.id, profileId: "staging-admin", ctx: ctx() });
  assert.equal(adapter.openSessionCount(), 0);
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [a.session_id]))[0].status, "CLOSED");
});

// ---- AC-005: no secret anywhere ------------------------------------------------------

test("AC-005: no secret value appears in results, logs, errors, DB rows or audit rows", async () => {
  await seedState();
  const results = [];
  results.push(await start());
  results.push(await start({ profileId: "saved" }));
  adapter.pages[`${ORIGIN}/admin`] = { redirect: `${ORIGIN}/login` };
  results.push(await start());
  adapter.pages[`${ORIGIN}/login`] = { redirect: `${FOREIGN}/x?token=${PASS_VALUE}` };
  results.push(await start());
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${SECRET_PASS}`];
  results.push(await start());
  const sid = results[0].session_id;
  results.push(await mgr.status({ project: PROJECT, sessionId: sid, ctx: ctx() }));
  await mgr.close({ project: PROJECT, sessionId: sid, ctx: ctx() });

  const dump = JSON.stringify({
    results,
    logs,
    sessions: await rows(`SELECT * FROM browser_sessions WHERE project_id = $1`, [projectA.id]),
    artifacts: await rows(`SELECT * FROM browser_session_artifacts WHERE session_id IN (SELECT id FROM browser_sessions WHERE project_id = $1)`, [projectA.id]),
    audit: await rows(`SELECT * FROM browser_audit_events WHERE project_id = $1`, [projectA.id]),
  });
  for (const secret of [PASS_VALUE, USER_VALUE, "cookie-sentinel-7c1"]) {
    assert.ok(!dump.includes(secret), `a secret value leaked: ${secret.slice(0, 6)}...`);
  }
});

test("removing a profile closes its live sessions first (spec section 9)", async () => {
  const { registerProfileRemovalHook } = await import("../src/browser/profileStore.js");
  await importProfile(PROJECT, profile({ profile_id: "temp" }));
  const r = await start({ profileId: "temp" });
  registerProfileRemovalHook(({ projectId, profileId, ctx: c }) => mgr.closeProfileSessions({ projectId, profileId, ctx: c }));
  try {
    await removeProfile(PROJECT, "temp", { ctx: ctx() });
  } finally {
    registerProfileRemovalHook(null);
  }
  assert.equal(adapter.openSessionCount(), 0);
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [r.session_id]))[0].status, "CLOSED");
  assert.equal(await getProfile(projectA.id, "temp"), null);
});

// ---- review fixes (2026-10-28) ------------------------------------------------------

test("verification passes on a page that only shares a prefix with the login path (/login-success)", async () => {
  await importProfile(PROJECT, profile({ profile_id: "prefix", verify: { url: `${ORIGIN}/login-success`, selector: "#bar" } }));
  adapter.pages[`${ORIGIN}/login-success`] = { selectors: { "#bar": "x" } };
  const r = await start({ profileId: "prefix" });
  assert.equal(r.status, "READY");
});

test("saved-state cookie values are redacted only while their session lives, and short words never are", async () => {
  const { saveStorageState } = await import("../src/browser/stateStore.js");
  const { redact } = await import("../src/browser/secrets.js");
  const { currentOrgId } = await import("../src/db.js");
  const LONG = "fake-scoped-cookie-31f9e2";
  await saveStorageState({ orgId: await currentOrgId(), project: PROJECT, profileId: "saved" }, {
    cookies: [{ name: "sid", value: LONG, domain: "x", path: "/" }, { name: "env", value: "staging", domain: "x", path: "/" }],
    origins: [],
  }, { baseDir: stateDir });
  const r = await start({ profileId: "saved" });
  assert.equal(r.status, "READY");
  assert.equal(redact(`env=staging sid=${LONG}`), "env=staging sid=[REDACTED]");
  await mgr.close({ project: PROJECT, sessionId: r.session_id, ctx: ctx() });
  assert.equal(redact(`sid=${LONG}`), `sid=${LONG}`, "the closed session's cookie is no longer registered");
});

test("close tears down this process's runtime even when another process already marked the row CLOSED", async () => {
  await importProfile(PROJECT, profile({ profile_id: "gone-elsewhere" }));
  const r = await start({ profileId: "gone-elsewhere" });
  assert.equal(adapter.openSessionCount(), 1);
  await removeProfile(PROJECT, "gone-elsewhere", { ctx: ctx() }); // no hook: as if run by another process
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [r.session_id]))[0].status, "CLOSED");
  assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: r.session_id, ctx: ctx() }), { session_id: r.session_id, status: "CLOSED" });
  assert.equal(adapter.openSessionCount(), 0, "the runtime outlived its CLOSED row");
  assert.equal(mgr.liveCount(), 0);
});

/** Hold the next createSession until release(); `entered` resolves once it is called. */
function gateLaunch() {
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const enteredP = new Promise((r) => { entered = r; });
  const orig = adapter.createSession;
  adapter.createSession = async (o) => {
    adapter.createSession = orig;
    entered();
    await gate;
    return orig(o);
  };
  return { release, entered: enteredP };
}

test("a teardown that runs while start() is still launching closes the runtime once it arrives", async () => {
  const g = gateLaunch();
  const p = start();
  await g.entered;
  await mgr.closeProfileSessions({ projectId: projectA.id, profileId: "staging-admin", ctx: ctx() });
  g.release();
  const r = await p;
  assert.notEqual(r.status, "READY");
  assert.equal(r.status, "CLOSED");
  assert.equal(adapter.openSessionCount(), 0, "the runtime created after teardown was never closed");
  assert.equal(mgr.liveCount(), 0);
});

test("a teardown while waiting for the adapter factory leaves no runtime behind", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  const fa = createFakeAdapter({ pages: structuredClone(GOOD_PAGES) });
  mgr = createSessionManager({
    adapterFactory: async () => { entered(); await gate; return fa; },
    stateDir, idleTimeoutMs: 60_000, hostname: "h1", pid: 111, bootId: "boot-A", isPidAlive: () => true,
  });
  const p = start();
  await enteredP;
  const shut = mgr.closeProfileSessions({ projectId: projectA.id, profileId: "staging-admin", ctx: ctx() });
  await shut;
  release();
  const r = await p;
  assert.equal(r.status, "CLOSED");
  assert.equal(fa.openSessionCount(), 0);
});

test("an idle timeout beyond the timer limit is clamped, not fired after ~1 ms", async () => {
  make({ idleTimeoutMs: 2 ** 31 + 5000 });
  const { session_id } = await start();
  await wait(80);
  assert.equal((await rows(`SELECT status FROM browser_sessions WHERE id = $1`, [session_id]))[0].status, "READY");
});

const leaseOf = async (sid) =>
  (await rows(`SELECT expires_at, expires_at > now() AS current FROM browser_sessions WHERE id = $1`, [sid]))[0];
const remoteHost = () => createSessionManager({ adapter: createFakeAdapter(), stateDir, hostname: "h2", pid: 5, bootId: "boot-C", isPidAlive: () => false });

test("a session still starting already has a cross-host lease, so another host can reclaim it once it lapses", async () => {
  const g = gateLaunch();
  const p = start();
  await g.entered;
  const sid = (await rows(`SELECT id FROM browser_sessions WHERE project_id = $1 AND status = 'STARTING' ORDER BY created_at DESC LIMIT 1`, [projectA.id]))[0].id;
  const lease = await leaseOf(sid);
  assert.ok(lease.expires_at, "a STARTING row has no lease");
  assert.equal(lease.current, true);
  await assert.rejects(remoteHost().status({ project: PROJECT, sessionId: sid, ctx: ctx() }), (e) => e.code === "session_not_in_this_process");
  await pool.query(`UPDATE browser_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [sid]);
  const s = await remoteHost().status({ project: PROJECT, sessionId: sid, ctx: ctx() });
  assert.equal(s.status, "FAILED");
  assert.equal(s.reason, "runtime_lost");
  g.release();
  await p;
});

test("with the idle timeout disabled, the owner keeps a heartbeat lease current, and stops when the session closes", async () => {
  make({ idleTimeoutMs: 0, ownerLeaseMs: 300 });
  const { session_id, status } = await start();
  assert.equal(status, "READY");
  const first = await leaseOf(session_id);
  assert.ok(first.expires_at, "READY with idle timeout 0 has no lease");
  await wait(600);
  const later = await leaseOf(session_id);
  assert.equal(later.current, true, "the owner did not refresh its lease");
  assert.ok(later.expires_at > first.expires_at);
  await assert.rejects(remoteHost().status({ project: PROJECT, sessionId: session_id, ctx: ctx() }), (e) => e.code === "session_not_in_this_process");
  await mgr.close({ project: PROJECT, sessionId: session_id, ctx: ctx() });
  const closed = await leaseOf(session_id);
  await wait(400);
  assert.deepEqual((await leaseOf(session_id)).expires_at, closed.expires_at, "the heartbeat outlived the session");
});
