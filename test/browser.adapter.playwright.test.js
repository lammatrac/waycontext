import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlaywrightAdapter, INSTALL_HINT } from "../src/browser/playwrightAdapter.js";

// ---- unit tests: no browser needed -------------------------------------------------

test("CON-002: only playwrightAdapter.js imports Playwright", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js") && /(from\s+|import\s*\(|require\()\s*["']playwright/.test(readFileSync(p, "utf8"))) {
        offenders.push(relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, ["browser/playwrightAdapter.js"]);
});

test("REQ-007: a missing playwright-core gives runtime_unavailable with the install command", async () => {
  const adapter = createPlaywrightAdapter({
    loader: async () => { throw Object.assign(new Error("Cannot find package 'playwright-core'"), { code: "ERR_MODULE_NOT_FOUND" }); },
  });
  await assert.rejects(adapter.createSession({ sessionId: "s", allowedOrigins: [] }), (e) => {
    assert.equal(e.code, "runtime_unavailable");
    assert.match(e.message, /npx playwright install chromium/);
    return true;
  });
  assert.match(INSTALL_HINT, /playwright-core/);
});

test("REQ-007: a missing Chromium binary gives runtime_unavailable", async () => {
  const adapter = createPlaywrightAdapter({
    loader: async () => ({
      chromium: { launch: async () => { throw new Error("browserType.launch: Executable doesn't exist at /x\nRun npx playwright install"); } },
    }),
  });
  await assert.rejects(adapter.createSession({ sessionId: "s", allowedOrigins: [] }), (e) => e.code === "runtime_unavailable");
});

test("any other launch failure gives runtime_launch_failed", async () => {
  const adapter = createPlaywrightAdapter({
    loader: async () => ({ chromium: { launch: async () => { throw new Error("spawn EACCES"); } } }),
  });
  await assert.rejects(adapter.createSession({ sessionId: "s", allowedOrigins: [] }), (e) => e.code === "runtime_launch_failed");
});

test("the module is not loaded until a session is requested", async () => {
  let loads = 0;
  const adapter = createPlaywrightAdapter({ loader: async () => { loads++; throw new Error("x"); } });
  assert.equal(loads, 0);
  await adapter.close();
  assert.equal(loads, 0);
});

// ---- integration tests: real Chromium against local fixture servers ----------------

let skipReason = null;
let allowed; // origin A: allowed
let foreign; // origin B: a different port, i.e. a different origin, never allowed
const foreignHits = [];
let servers = [];

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ s, origin: `http://127.0.0.1:${s.address().port}` }));
  });
}

before(async () => {
  const b = await listen((req, res) => { foreignHits.push(req.url); res.end("<h1>foreign</h1>"); });
  foreign = b.origin;
  const a = await listen((req, res) => {
    const html = (body, extra = {}) => { res.writeHead(200, { "content-type": "text/html", ...extra }); res.end(body); };
    switch (req.url.split("?")[0]) {
      case "/ok": return html("<h1 id=hi>Hello allowed</h1>");
      case "/redirect": res.writeHead(302, { location: `${foreign}/landing` }); return res.end();
      case "/hop1": res.writeHead(302, { location: "/hop2", "set-cookie": "hop=1; Path=/" }); return res.end();
      case "/hop2": res.writeHead(301, { location: "/ok?from=hop" }); return res.end();
      case "/redirect-chain": res.writeHead(302, { location: "/redirect" }); return res.end();
      case "/script": return html(`<script>setTimeout(() => { location.href = "${foreign}/landing"; }, 20)</script>`);
      case "/popup": return html(`<script>window.open("${foreign}/landing")</script>`);
      case "/popup-ok": return html(`<script>window.open("/ok")</script>`);
      case "/form": return html(`<input id=u><button id=go onclick="document.title='clicked'">go</button><p id=msg>Form page</p>`);
      case "/setcookie": return html("ok", { "set-cookie": "sid=abc123; Path=/" });
      case "/whoami": return html(`<p id=c>${req.headers.cookie ?? "none"}</p>`);
      default: res.writeHead(404); return res.end("nope");
    }
  });
  allowed = a.origin;
  servers = [a.s, b.s];
  const probe = createPlaywrightAdapter();
  try {
    const s = await probe.createSession({ sessionId: "probe", allowedOrigins: [allowed] });
    await s.close();
  } catch (e) {
    skipReason = `Chromium unavailable (${e.code ?? "error"}): ${String(e.message).split("\n")[0]}`;
  } finally {
    await probe.close();
  }
  if (skipReason) console.log(`# integration tests skipped: ${skipReason}`);
});

after(() => { for (const s of servers) s.close(); });

async function withSession(opts, fn) {
  const adapter = createPlaywrightAdapter();
  const blocked = [];
  const session = await adapter.createSession({ sessionId: "it", allowedOrigins: [allowed], onBlocked: (e) => blocked.push(e), ...opts });
  try { return await fn(session, blocked, adapter); } finally { await adapter.close(); }
}

const it = (name, fn) => test(name, async (t) => {
  if (skipReason) return t.skip(skipReason);
  await fn(t);
});

it("an allowed origin loads and primitives work", async () => {
  await withSession({}, async (s, blocked) => {
    const r = await s.goto(`${allowed}/ok`);
    assert.equal(r.status, 200);
    assert.equal(await s.containsText("Hello allowed"), true);
    assert.equal(await s.textContent("#hi"), "Hello allowed");
    assert.equal(await s.exists("#nope", { timeoutMs: 100 }), false);
    await s.goto(`${allowed}/form`);
    await s.fill("#u", "alice");
    await s.click("#go");
    assert.equal(await s.exists("#u"), true);
    const png = await s.screenshot();
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const state = await s.storageState();
    assert.ok(Array.isArray(state.cookies));
    assert.equal(blocked.length, 0);
  });
});

it("a direct navigation to another origin is blocked before any request reaches it", async () => {
  foreignHits.length = 0;
  await withSession({}, async (s, blocked) => {
    await assert.rejects(s.goto(`${foreign}/landing?token=zzz`), (e) => e.code === "origin_blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].kind, "navigation");
    assert.equal(blocked[0].url, `${foreign}/landing`);
  });
  assert.deepEqual(foreignHits, []);
});

it("a cross-origin redirect is blocked and the foreign server gets no request", async () => {
  foreignHits.length = 0;
  await withSession({}, async (s, blocked) => {
    await assert.rejects(s.goto(`${allowed}/redirect`), (e) => e.code === "origin_blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].kind, "redirect");
    assert.equal(blocked[0].origin, foreign);
    await assert.rejects(s.goto(`${allowed}/redirect-chain`), (e) => e.code === "origin_blocked");
  });
  assert.deepEqual(foreignHits, []);
});

it("same-origin redirect chains still work and land on the final page", async () => {
  await withSession({}, async (s, blocked) => {
    for (let i = 0; i < 5; i++) {
      const r = await s.goto(`${allowed}/hop1`);
      assert.equal(r.status, 200);
      assert.equal(r.url, `${allowed}/ok?from=hop`);
    }
    assert.equal(await s.containsText("Hello allowed"), true);
    assert.equal(blocked.length, 0);
    assert.ok((await s.storageState()).cookies.some((c) => c.name === "hop"));
  });
});

it("a window.location change to another origin is blocked", async () => {
  foreignHits.length = 0;
  await withSession({}, async (s, blocked) => {
    await assert.rejects(s.goto(`${allowed}/script`), (e) => e.code === "origin_blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].kind, "script");
    assert.ok(!(await s.url()).startsWith(foreign));
  });
  assert.deepEqual(foreignHits, []);
});

it("a popup to another origin is blocked and closed; a same-origin popup is allowed", async () => {
  foreignHits.length = 0;
  await withSession({}, async (s, blocked) => {
    await assert.rejects(s.goto(`${allowed}/popup`), (e) => e.code === "origin_blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].kind, "popup");
    await s.goto(`${allowed}/popup-ok`);
    assert.equal(blocked.length, 1);
  });
  assert.deepEqual(foreignHits, []);
});

it("non-http urls are refused by the guard", async () => {
  await withSession({}, async (s, blocked) => {
    await assert.rejects(s.goto("file:///etc/hostname"), (e) => e.code === "origin_blocked");
    assert.equal(blocked.length, 1);
  });
});

it("REQ-008: two sessions share no cookies", async () => {
  const adapter = createPlaywrightAdapter();
  try {
    const one = await adapter.createSession({ sessionId: "one", allowedOrigins: [allowed] });
    const two = await adapter.createSession({ sessionId: "two", allowedOrigins: [allowed] });
    await one.goto(`${allowed}/setcookie`);
    await one.goto(`${allowed}/whoami`);
    assert.equal(await one.textContent("#c"), "sid=abc123");
    await two.goto(`${allowed}/whoami`);
    assert.equal(await two.textContent("#c"), "none");
    const state = await one.storageState();
    const three = await adapter.createSession({ sessionId: "three", allowedOrigins: [allowed], storageState: state });
    await three.goto(`${allowed}/whoami`);
    assert.equal(await three.textContent("#c"), "sid=abc123");
  } finally {
    await adapter.close();
  }
});

function chromiumPids() {
  // Only this process's own children: test files run in parallel, and another
  // file's browser must not count as a leak here.
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  return out.split("\n").filter((l) => /playwright_chromiumdev_profile/.test(l))
    .map((l) => l.trim().split(/\s+/)).filter((f) => Number(f[1]) === process.pid).map((f) => f[0]);
}

it("teardown leaves no browser process behind", async () => {
  const before = new Set(chromiumPids());
  const adapter = createPlaywrightAdapter();
  const s = await adapter.createSession({ sessionId: "td", allowedOrigins: [allowed] });
  await s.goto(`${allowed}/ok`);
  const during = chromiumPids().filter((p) => !before.has(p));
  assert.ok(during.length > 0, "expected a chromium process while the session is open");
  await s.close();
  await s.close(); // idempotent
  assert.equal(s.isAlive(), false);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(chromiumPids().filter((p) => !before.has(p)), []);
  await adapter.close();
});

it("a browser that dies reports onClosed and marks the session dead", async () => {
  const closed = [];
  const adapter = createPlaywrightAdapter();
  const s = await adapter.createSession({ sessionId: "dead", allowedOrigins: [allowed], onClosed: (r) => closed.push(r) });
  s._browser.close(); // simulate runtime loss from outside the adapter's own close path
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(closed, ["disconnected"]);
  assert.equal(s.isAlive(), false);
  await adapter.close();
});

// ---- review fixes (2026-10-28) ------------------------------------------------------

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

it("a page crash followed by close() still releases the shared browser (no process left)", async () => {
  const before = new Set(chromiumPids());
  const closed = [];
  const adapter = createPlaywrightAdapter();
  try {
    const s = await adapter.createSession({ sessionId: "crash", allowedOrigins: [allowed], onClosed: (r) => closed.push(r) });
    await s.goto(`${allowed}/ok`);
    s._page.goto("chrome://crash").catch(() => {}); // a real renderer crash
    assert.ok(await waitFor(() => closed.length > 0), "onClosed never fired after the crash");
    assert.deepEqual(closed, ["crashed"]);
    assert.equal(s.isAlive(), false);
    await s.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(chromiumPids().filter((p) => !before.has(p)), [], "the browser outlived its last session");
  } finally {
    await adapter.close();
  }
});

it("the main page closed from outside the adapter is a death: onClosed('page_closed'), not alive, released on close", async () => {
  const before = new Set(chromiumPids());
  const closed = [];
  const adapter = createPlaywrightAdapter();
  try {
    const s = await adapter.createSession({ sessionId: "pclose", allowedOrigins: [allowed], onClosed: (r) => closed.push(r) });
    await s.goto(`${allowed}/ok`);
    await s._page.close(); // e.g. the human closing the window/tab
    assert.ok(await waitFor(() => closed.length > 0), "onClosed never fired after the page closed");
    assert.deepEqual(closed, ["page_closed"]);
    assert.equal(s.isAlive(), false);
    await s.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(chromiumPids().filter((p) => !before.has(p)), []);
  } finally {
    await adapter.close();
  }
});

it("the adapter's own close() does not report onClosed", async () => {
  const closed = [];
  await withSession({ onClosed: (r) => closed.push(r) }, async (s) => {
    await s.goto(`${allowed}/ok`);
    await s.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(closed, []);
  });
});
