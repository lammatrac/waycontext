process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb } = await import("../src/db.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { createPlaywrightAdapter } = await import("../src/browser/playwrightAdapter.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { setSessionManager, shutdownBrowserSessions, browserNavigateOp, browserCaptureScreenshotOp } = await import("../src/browser/ops.js");
const { listArtifacts } = await import("../src/browser/stateStore.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

// Real Chromium against local fixtures. Fake secret names and values only.
const PROJECT = "bsm_nav_e2e";
const USER_ENV = "FAKE_NAVE2E_USER";
const PASS_ENV = "FAKE_NAVE2E_PASS";
const USER = "nav-user";
const PASS = "nav-e2e-sentinel-pass-41d9";

let skipReason = null;
let site, foreign, siteOrigin, foreignOrigin, stateDir, mgr;
const foreignHits = [];
const valid = new Set();
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve({ s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const ctx = () => ({ log() {}, surface: "mcp", correlationId: "nav-e2e" });
const nav = (sid, url) => browserNavigateOp({ project: PROJECT, session_id: sid, url }, ctx());

before(async () => {
  await initDb();
  foreign = (await listen((req, res) => { foreignHits.push(req.url); res.end("foreign"); }));
  foreignOrigin = foreign.origin; foreign = foreign.s;
  const a = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
    const go = (loc, extra = {}) => { res.writeHead(302, { location: loc, ...extra }); res.end(); };
    if (url.pathname === "/login") return html(`<form method=post action=/do-login><input id=user name=user><input id=pass name=pass type=password><button id=submit>Go</button></form>`);
    if (url.pathname === "/do-login") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = new URLSearchParams(body);
        if (p.get("user") === USER && p.get("pass") === PASS) { valid.add("c1"); return go("/admin", { "set-cookie": "sid=c1; Path=/; HttpOnly" }); }
        return go("/login?failed=1");
      });
      return;
    }
    const authed = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (url.pathname === "/admin") return valid.has(authed) ? html(`<h1>Dashboard</h1><div id=bar></div>`) : go("/login");
    if (url.pathname === "/page") return valid.has(authed) ? html(`<h1 style="font-size:60px">Fixture Page</h1>`) : go("/login");
    if (url.pathname === "/to-foreign") return go(`${foreignOrigin}/phish`);
    if (url.pathname === "/invalidate") { valid.clear(); return html("ok"); }
    res.writeHead(404); res.end("nope");
  });
  site = a.s; siteOrigin = a.origin;

  const probe = createPlaywrightAdapter();
  try {
    await (await probe.createSession({ sessionId: "probe", allowedOrigins: [siteOrigin] })).close();
  } catch (e) {
    skipReason = `Chromium unavailable (${e.code ?? "error"}): ${String(e.message).split("\n")[0]}`;
  } finally { await probe.close(); }
  if (skipReason) { console.log(`# nav e2e skipped: ${skipReason}`); return; }

  await cleanupTestProject(PROJECT);
  await createTestProject(PROJECT);
  await importProfile(PROJECT, {
    profile_id: "fresh", environment: "local", base_url: siteOrigin, allowed_origins: [siteOrigin],
    auth: { mode: "fresh_login" },
    login: { url: `${siteOrigin}/login`, username_selector: "#user", password_selector: "#pass", submit_selector: "#submit", username_secret: USER_ENV, password_secret: PASS_ENV },
    verify: { url: `${siteOrigin}/admin`, selector: "#bar", text: "Dashboard" },
  });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-nave2e-"));
  mgr = createSessionManager({ adapter: createPlaywrightAdapter(), stateDir, idleTimeoutMs: 60_000 });
  setSessionManager(mgr);
  process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`] = USER;
  process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`] = PASS;
});

after(async () => {
  await shutdownBrowserSessions();
  setSessionManager(null);
  site?.close(); foreign?.close();
  if (!skipReason) {
    await cleanupTestProject(PROJECT);
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${USER_ENV}`];
  delete process.env[`WAYCONTEXT_BROWSER_SECRET_${PASS_ENV}`];
  clearSensitive();
  await pool.end();
});

test("real Chromium: navigate, block a foreign origin, screenshot, then expire", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const started = await mgr.start({ project: PROJECT, profileId: "fresh", purpose: "nav e2e", ctx: ctx() });
  assert.equal(started.status, "READY");
  const sid = started.session_id;

  const ok = await nav(sid, `${siteOrigin}/page`);
  assert.deepEqual(ok, { final_url: `${siteOrigin}/page`, http_status: 200, status: "READY" });

  for (const url of [`${foreignOrigin}/direct`, `${siteOrigin}/to-foreign`]) {
    await assert.rejects(nav(sid, url), (e) => e.code === "origin_blocked");
  }
  assert.deepEqual(foreignHits, [], "the foreign server must receive no request");
  assert.equal((await mgr.status({ project: PROJECT, sessionId: sid, ctx: ctx() })).status, "READY");

  await nav(sid, `${siteOrigin}/page`);
  const shot = await browserCaptureScreenshotOp({ project: PROJECT, session_id: sid }, ctx());
  assert.ok(fs.existsSync(shot.path));
  assert.equal(fs.statSync(shot.path).mode & 0o777, 0o600);
  assert.ok(shot.path.startsWith(stateDir));
  assert.ok(!shot.path.startsWith(process.cwd()), "outside the project root");
  assert.deepEqual([...fs.readFileSync(shot.path).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(shot.width > 1 && shot.height > 1);
  assert.equal((await listArtifacts(sid)).filter((r) => r.artifact_type === "screenshot").length, 1);

  const full = await browserCaptureScreenshotOp({ project: PROJECT, session_id: sid, full_page: true }, ctx());
  assert.ok(full.height >= shot.height);

  // The server drops the login: the next protected page redirects to /login -> EXPIRED.
  await nav(sid, `${siteOrigin}/invalidate`);
  const expired = await nav(sid, `${siteOrigin}/admin`);
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.reason, "state_expired");
  await assert.rejects(nav(sid, `${siteOrigin}/page`), (e) => e.code === "session_not_ready");
});
