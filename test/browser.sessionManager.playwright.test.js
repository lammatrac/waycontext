process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { pool, initDb } = await import("../src/db.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { createPlaywrightAdapter } = await import("../src/browser/playwrightAdapter.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

// Real Chromium against a local form-login fixture. Fake secret names and values only.
const PROJECT = "bsm_e2e_a";
const OTHER = "bsm_e2e_b";
const USER_ENV = "FAKE_E2E_USER";
const PASS_ENV = "FAKE_E2E_PASS";
const USER = "e2e-user";
const PASS = "e2e-sentinel-pass-8c3f1a";
const COOKIE = "e2e-sentinel-cookie-b7d204";

let skipReason = null;
let site, foreign, siteOrigin, foreignOrigin, stateDir, adapter, mgr, project;
const foreignHits = [];
const valid = new Set();
const logs = [];
const stderrChunks = [];
const origWrite = process.stderr.write.bind(process.stderr);

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve({ s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const cookieOf = (req) => /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
let nextCookie = 0;

before(async () => {
  await initDb();
  const f = await listen((req, res) => { foreignHits.push(req.url); res.end("foreign"); });
  foreign = f.s; foreignOrigin = f.origin;
  const a = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (b, code = 200) => { res.writeHead(code, { "content-type": "text/html" }); res.end(b); };
    const go = (loc, extra = {}) => { res.writeHead(302, { location: loc, ...extra }); res.end(); };
    if (url.pathname === "/login") return html(`<form method=post action=/do-login><input id=user name=user><input id=pass name=pass type=password><button id=submit>Go</button></form>`);
    if (url.pathname === "/to-foreign") return go(`${foreignOrigin}/phish`);
    if (url.pathname === "/do-login") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = new URLSearchParams(body);
        if (p.get("user") === USER && p.get("pass") === PASS) {
          const c = `${COOKIE}-${nextCookie++}`;
          valid.add(c);
          return go("/admin", { "set-cookie": `sid=${c}; Path=/; HttpOnly` });
        }
        return go("/login?failed=1");
      });
      return;
    }
    if (url.pathname === "/admin") {
      return valid.has(cookieOf(req)) ? html(`<h1>Dashboard</h1><div id=bar></div><span id=me>Administrator</span>`) : go("/login");
    }
    if (url.pathname === "/invalidate") { valid.clear(); return html("ok"); }
    if (url.pathname === "/logout") { valid.delete(cookieOf(req)); return html("bye"); }
    res.writeHead(404); res.end("nope");
  });
  site = a.s; siteOrigin = a.origin;

  const probe = createPlaywrightAdapter();
  try {
    await (await probe.createSession({ sessionId: "probe", allowedOrigins: [siteOrigin] })).close();
  } catch (e) {
    skipReason = `Chromium unavailable (${e.code ?? "error"}): ${String(e.message).split("\n")[0]}`;
  } finally {
    await probe.close();
  }
  if (skipReason) { console.log(`# e2e skipped: ${skipReason}`); return; }

  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  project = await createTestProject(PROJECT);
  await createTestProject(OTHER);
  const base = {
    environment: "local", base_url: siteOrigin, allowed_origins: [siteOrigin],
    login: {
      url: `${siteOrigin}/login`, username_selector: "#user", password_selector: "#pass", submit_selector: "#submit",
      username_secret: USER_ENV, password_secret: PASS_ENV,
    },
    verify: { url: `${siteOrigin}/admin`, selector: "#bar", text: "Dashboard", identity_selector: "#me" },
  };
  await importProfile(PROJECT, { ...base, profile_id: "fresh", auth: { mode: "fresh_login", save_state: true } });
  await importProfile(PROJECT, { ...base, profile_id: "saved", auth: { mode: "saved_state" } });
  await importProfile(PROJECT, { ...base, profile_id: "phish", auth: { mode: "fresh_login" }, login: { ...base.login, url: `${siteOrigin}/to-foreign` } });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-e2e-"));
  adapter = createPlaywrightAdapter();
  mgr = createSessionManager({ adapter, stateDir, idleTimeoutMs: 60_000 });
  process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`] = USER;
  process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`] = PASS;
  process.stderr.write = (c, ...r) => { stderrChunks.push(String(c)); return origWrite(c, ...r); };
});

after(async () => {
  process.stderr.write = origWrite;
  if (mgr) await mgr.shutdown({ ctx: { surface: "mcp" } });
  site?.close(); foreign?.close();
  if (!skipReason) {
    await cleanupTestProject(PROJECT);
    await cleanupTestProject(OTHER);
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`];
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`];
  clearSensitive();
  await pool.end();
});

const ctx = () => ({ log: (m) => logs.push(m), surface: "mcp", correlationId: "e2e" });
const start = (profileId) => mgr.start({ project: PROJECT, profileId, purpose: "e2e", ctx: ctx() });
const results = [];
const it = (name, fn) => test(name, async (t) => { if (skipReason) return t.skip(skipReason); await fn(t); });
const chromeChildren = () => {
  try {
    const kids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean);
    return kids.filter((p) => /chrom|headless/i.test(fs.readFileSync(`/proc/${p}/comm`, "utf8")));
  } catch { return []; }
};

it("a wrong password fails verification (AC-003)", async () => {
  process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`] = "wrong-fake-password";
  try {
    const r = await start("fresh");
    results.push(r);
    assert.equal(r.status, "FAILED");
    assert.ok(["verification_failed", "login_failed"].includes(r.reason));
  } finally {
    process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`] = PASS;
  }
});

it("fresh_login reaches READY, saves state at 0600, then saved_state reaches READY without secrets, then close", async () => {
  const r = await start("fresh");
  results.push(r);
  assert.equal(r.status, "READY");
  assert.deepEqual(r.identity, { verified: true, role: "Administrator" });

  const art = (await pool.query(`SELECT storage_ref FROM browser_session_artifacts WHERE session_id = $1`, [r.session_id])).rows[0];
  const file = path.join(stateDir, ...art.storage_ref.replace(/^storage_state:/, "").split("/"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(COOKIE), "the state file holds the cookie (and only there)");
  assert.ok(!file.startsWith(project.root_path));

  assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: r.session_id, ctx: ctx() }), { session_id: r.session_id, status: "CLOSED" });

  // State is keyed by profile id and a profile has one auth mode, so the saved_state profile
  // gets its state the way P6's browser-login will: saved under its own id.
  const { loadStorageState, saveStorageState } = await import("../src/browser/stateStore.js");
  const { currentOrgId } = await import("../src/db.js");
  const orgId = await currentOrgId();
  await saveStorageState({ orgId, project: PROJECT, profileId: "saved" }, loadStorageState({ orgId, project: PROJECT, profileId: "fresh" }, { baseDir: stateDir }), { baseDir: stateDir });

  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`];
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`];
  try {
    const s = await start("saved");
    results.push(s);
    assert.equal(s.status, "READY");
    assert.equal(s.auth_mode, "saved_state");
    assert.deepEqual(await mgr.close({ project: PROJECT, sessionId: s.session_id, ctx: ctx() }), { session_id: s.session_id, status: "CLOSED" });
  } finally {
    process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`] = USER;
    process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`] = PASS;
  }
  assert.equal(chromeChildren().length, 0, "no browser child process remains after close (AC-009)");
});

it("the site invalidating the session makes saved_state EXPIRED/state_expired (AC-004)", async () => {
  await fetch(`${siteOrigin}/invalidate`);
  const e = await start("saved");
  results.push(e);
  assert.equal(e.status, "EXPIRED");
  assert.equal(e.reason, "state_expired");
});

it("two sessions on one profile do not share cookies: logging out in one leaves the other READY (AC-006)", async () => {
  const a = await start("fresh");
  const b = await start("fresh");
  results.push(a, b);
  assert.equal(a.status, "READY");
  assert.equal(b.status, "READY");
  await mgr.withSession({ project: PROJECT, sessionId: a.session_id, tool: "t", ctx: ctx() }, async ({ runtime }) => { await runtime.goto(`${siteOrigin}/logout`); });
  const still = await mgr.withSession({ project: PROJECT, sessionId: b.session_id, tool: "t", ctx: ctx() }, async ({ runtime }) => {
    const r = await runtime.goto(`${siteOrigin}/admin`);
    return { status: r.status, url: await runtime.url() };
  });
  assert.equal(still.status, 200);
  assert.equal(still.url, `${siteOrigin}/admin`);
  await assert.rejects(mgr.status({ project: OTHER, sessionId: a.session_id, ctx: ctx() }), (e) => e.code === "session_not_found");
  await mgr.close({ project: PROJECT, sessionId: a.session_id, ctx: ctx() });
  await mgr.close({ project: PROJECT, sessionId: b.session_id, ctx: ctx() });
});

it("a disallowed redirect during login is FAILED and the foreign server never sees a request (REQ-015)", async () => {
  const r = await start("phish");
  results.push(r);
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "login_failed");
  assert.deepEqual(foreignHits, []);
  const ev = (await pool.query(`SELECT * FROM browser_audit_events WHERE session_id = $1 AND event_type = 'origin_blocked'`, [r.session_id])).rows;
  assert.equal(ev.length, 1);
});

it("killing the browser process makes status FAILED/runtime_lost (AC-008)", async (t) => {
  const r = await start("fresh");
  assert.equal(r.status, "READY");
  const kids = chromeChildren();
  if (!kids.length) { await mgr.close({ project: PROJECT, sessionId: r.session_id, ctx: ctx() }); return t.skip("could not find the browser child process"); }
  for (const p of kids) process.kill(Number(p), "SIGKILL");
  const ok = await (async () => {
    for (let i = 0; i < 100; i++) {
      const s = await mgr.status({ project: PROJECT, sessionId: r.session_id, ctx: ctx() });
      if (s.status !== "READY") return s;
      await new Promise((res) => setTimeout(res, 50));
    }
    return null;
  })();
  assert.ok(ok, "status never left READY");
  assert.equal(ok.status, "FAILED");
  assert.equal(ok.reason, "runtime_lost");
});

it("AC-005: neither the password nor the cookie value appears in results, logs, stderr or any browser_* row", async () => {
  const sessions = (await pool.query(`SELECT * FROM browser_sessions WHERE project_id = $1`, [project.id])).rows;
  const dump = JSON.stringify({
    results, logs, stderr: stderrChunks, sessions,
    artifacts: (await pool.query(`SELECT * FROM browser_session_artifacts WHERE session_id = ANY($1)`, [sessions.map((s) => s.id)])).rows,
    audit: (await pool.query(`SELECT * FROM browser_audit_events WHERE project_id = $1`, [project.id])).rows,
  });
  assert.ok(dump.length > 500);
  for (const secret of [PASS, "wrong-fake-password", COOKIE, USER]) {
    assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 8)}...`);
  }
});
