process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb, currentOrgId } = await import("../src/db.js");
const { createPlaywrightAdapter } = await import("../src/browser/playwrightAdapter.js");
const { createSessionManager } = await import("../src/browser/sessionManager.js");
const { captureLogin } = await import("../src/browser/loginCapture.js");
const { importProfile } = await import("../src/browser/profileStore.js");
const { hasSavedState } = await import("../src/browser/stateStore.js");
const { clearSensitive } = await import("../src/browser/secrets.js");
const { createTestProject, cleanupTestProject } = await import("./helpers/testProject.js");

// Real Chromium, headed when a display exists, against a local form-login fixture. The "human"
// is the test driving the form from the completion hook. Fake credentials only.
const PROJECT = "bsm_login_e2e";
const USER = "e2e-human";
const PASS = "e2e-login-sentinel-5d21c9";
const COOKIE = "e2e-login-cookie-9a40be";

let skipReason = null;
let headed = true;
let note = "";
let site, origin, stateDir, adapter, project;
const valid = new Set();

before(async () => {
  await initDb();
  site = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
    const go = (loc, h = {}) => { res.writeHead(302, { location: loc, ...h }); res.end(); };
    if (url.pathname === "/login") return html(`<form method=post action=/do-login><input id=user name=user><input id=pass name=pass type=password><button id=submit>Go</button></form>`);
    if (url.pathname === "/do-login") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = new URLSearchParams(body);
        if (p.get("user") === USER && p.get("pass") === PASS) { valid.add(COOKIE); return go("/admin", { "set-cookie": `sid=${COOKIE}; Path=/; HttpOnly` }); }
        go("/login?failed=1");
      });
      return;
    }
    if (url.pathname === "/admin") {
      return /sid=([^;]+)/.exec(req.headers.cookie ?? "") && valid.has(/sid=([^;]+)/.exec(req.headers.cookie)[1])
        ? html(`<h1>Dashboard</h1><div id=bar></div><span id=me>Administrator</span>`) : go("/login");
    }
    res.writeHead(404); res.end("nope");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${site.address().port}`;

  // Probe: headed if a display exists, else headless fallback (stated), else skip.
  adapter = createPlaywrightAdapter();
  try {
    await (await adapter.createSession({ sessionId: "probe", allowedOrigins: [origin], headed: true })).close();
    note = `headed Chromium (DISPLAY=${process.env.DISPLAY ?? ""} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? ""})`;
  } catch (e) {
    headed = false;
    try {
      await (await adapter.createSession({ sessionId: "probe2", allowedOrigins: [origin] })).close();
      note = `no usable display (${e.code}); FELL BACK TO HEADLESS`;
    } catch (e2) {
      skipReason = `Chromium unavailable (${e2.code ?? "error"}): ${String(e2.message).split("\n")[0]}`;
    }
  }
  console.log(skipReason ? `# login e2e skipped: ${skipReason}` : `# login e2e ran with ${note}`);
  if (skipReason) return;
  await cleanupTestProject(PROJECT);
  project = await createTestProject(PROJECT);
  await importProfile(PROJECT, {
    profile_id: "saved", environment: "local", base_url: origin, allowed_origins: [origin],
    auth: { mode: "saved_state" },
    login: {
      url: `${origin}/login`, username_selector: "#user", password_selector: "#pass", submit_selector: "#submit",
      username_secret: "UNUSED_E2E_USER", password_secret: "UNUSED_E2E_PASS",
    },
    verify: { url: `${origin}/admin`, selector: "#bar", text: "Dashboard", identity_selector: "#me" },
  });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-login-e2e-"));
});

after(async () => {
  await adapter?.close();
  site?.close();
  if (!skipReason) {
    await cleanupTestProject(PROJECT);
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }
  clearSensitive();
  await pool.end();
});

// When there is no display, run headless but still through the same code path.
const runAdapter = () => headed ? adapter : {
  createSession: (o) => adapter.createSession({ ...o, headed: false }),
  close: () => adapter.close(),
};
const human = (user, pass) => async ({ session }) => {
  await session.fill("#user", user);
  await session.fill("#pass", pass);
  await session.click("#submit");
};
const it = (name, fn) => test(name, async (t) => { if (skipReason) return t.skip(skipReason); await fn(t); });

it("a failed human login saves nothing (wrong password)", async () => {
  const ctx = { surface: "cli", correlationId: "c-fail", log() {} };
  await assert.rejects(
    captureLogin({ project: PROJECT, profileId: "saved", adapter: runAdapter(), stateDir, ctx, timeoutMs: 20_000, waitForDone: human(USER, "wrong") }),
    (e) => e.code === "verification_failed"
  );
  assert.equal(hasSavedState({ orgId: await currentOrgId(), project: PROJECT, profileId: "saved" }, { baseDir: stateDir }), false);
});

it("a human login is captured at 0600 and a saved_state session then reaches READY in the same process", async () => {
  const ctx = { surface: "cli", correlationId: "c-ok", log() {} };
  const out = await captureLogin({ project: PROJECT, profileId: "saved", adapter: runAdapter(), stateDir, ctx, timeoutMs: 20_000, waitForDone: human(USER, PASS) });
  assert.equal(out.verified, true);
  assert.deepEqual(out.identity, { verified: true, role: "Administrator" });
  const sc = { orgId: await currentOrgId(), project: PROJECT, profileId: "saved" };
  assert.equal(hasSavedState(sc, { baseDir: stateDir }), true);
  const file = path.join(stateDir, ...out.storage_ref.slice("storage_state:".length).split("/").map(decodeURIComponent));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(file, "utf8").includes(COOKIE), "state holds the session cookie");

  const mgr = createSessionManager({ adapter, stateDir, idleTimeoutMs: 60_000 });
  try {
    const r = await mgr.start({ project: PROJECT, profileId: "saved", purpose: "after browser-login", ctx: { surface: "mcp", correlationId: "c-s", log() {} } });
    assert.equal(r.status, "READY");
    assert.deepEqual(r.identity, { verified: true, role: "Administrator" });
  } finally {
    await mgr.shutdown({ ctx: { surface: "mcp" } });
  }
  const rows = (await pool.query(`SELECT event_type, actor FROM browser_audit_events WHERE project_id = $1 AND correlation_id = 'c-ok' ORDER BY id`, [project.id])).rows;
  assert.deepEqual(rows.map((r) => r.event_type), ["manual_login_started", "state_save", "manual_login_finished"]);
  assert.ok(rows.every((r) => r.actor === "cli"));
});

it("the guard blocks the human navigating to a foreign origin in the real browser", async () => {
  const foreign = http.createServer((q, r) => r.end("foreign"));
  await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
  const fOrigin = `http://127.0.0.1:${foreign.address().port}`;
  try {
    let blocked;
    const ctx = { surface: "cli", correlationId: "c-guard", log() {} };
    await captureLogin({
      project: PROJECT, profileId: "saved", adapter: runAdapter(), stateDir, ctx, timeoutMs: 20_000,
      waitForDone: async (h) => { blocked = await h.session.goto(`${fOrigin}/phish`).catch((e) => e); await human(USER, PASS)(h); },
    });
    assert.equal(blocked.code, "origin_blocked");
    const b = (await pool.query(`SELECT actor, result FROM browser_audit_events WHERE correlation_id = 'c-guard' AND event_type = 'origin_blocked'`)).rows;
    assert.deepEqual(b, [{ actor: "cli", result: "blocked" }]);
  } finally {
    foreign.close();
  }
});
