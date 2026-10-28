import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeAdapter } from "../src/browser/fakeAdapter.js";
import { ADAPTER_METHODS, SESSION_METHODS, assertAdapterShape } from "../src/browser/adapter.js";

const ALLOWED = ["https://app.test"];

function setup(pages = {}) {
  const blocked = [];
  const adapter = createFakeAdapter({ pages });
  const open = (extra = {}) =>
    adapter.createSession({ sessionId: "s1", allowedOrigins: ALLOWED, onBlocked: (e) => blocked.push(e), ...extra });
  return { adapter, blocked, open };
}

test("the fake satisfies the adapter interface", async () => {
  const { adapter, open } = setup();
  assertAdapterShape(adapter);
  const session = await open();
  for (const m of SESSION_METHODS) assert.equal(typeof session[m], "function", m);
  for (const m of ADAPTER_METHODS) assert.equal(typeof adapter[m], "function", m);
});

test("goto on an allowed origin returns the final url and status", async () => {
  const { open, blocked } = setup({ "https://app.test/a": {} });
  const s = await open();
  const r = await s.goto("https://app.test/a");
  assert.deepEqual(r, { url: "https://app.test/a", status: 200 });
  assert.equal(await s.url(), "https://app.test/a");
  assert.equal(blocked.length, 0);
});

test("goto to a foreign origin throws origin_blocked and reports it without the query string", async () => {
  const { open, blocked } = setup();
  const s = await open();
  await assert.rejects(s.goto("https://evil.test/x?token=abc"), (e) => e.code === "origin_blocked");
  assert.deepEqual(blocked, [
    { sessionId: "s1", url: "https://evil.test/x", origin: "https://evil.test", kind: "navigation" },
  ]);
  assert.equal(await s.url(), "about:blank");
});

test("a redirect to a foreign origin is blocked as a redirect", async () => {
  const { open, blocked } = setup({ "https://app.test/r": { redirect: "https://evil.test/landing" } });
  const s = await open();
  await assert.rejects(s.goto("https://app.test/r"), (e) => e.code === "origin_blocked");
  assert.equal(blocked[0].kind, "redirect");
  assert.equal(blocked[0].origin, "https://evil.test");
});

test("a script navigation to a foreign origin is blocked", async () => {
  const { open, blocked } = setup({ "https://app.test/s": { scriptNavigateTo: "https://evil.test/" } });
  const s = await open();
  await assert.rejects(s.goto("https://app.test/s"), (e) => e.code === "origin_blocked");
  assert.equal(blocked[0].kind, "script");
});

test("a popup to a foreign origin is blocked and closed; an allowed popup is kept", async () => {
  const { open, blocked } = setup({ "https://app.test/p": { popup: "https://evil.test/" } });
  const s = await open();
  await assert.rejects(s.goto("https://app.test/p"), (e) => e.code === "origin_blocked");
  assert.equal(blocked[0].kind, "popup");
  assert.equal(s.pageCount(), 1);
});

test("the guard callback may throw without breaking the block", async () => {
  const adapter = createFakeAdapter({});
  const s = await adapter.createSession({ sessionId: "x", allowedOrigins: ALLOWED, onBlocked: () => { throw new Error("boom"); } });
  await assert.rejects(s.goto("https://evil.test/"), (e) => e.code === "origin_blocked");
});

test("close is idempotent, flips isAlive and runs onClosed once per crash", async () => {
  const { adapter, open } = setup();
  const closedEvents = [];
  const s = await open({ onClosed: (r) => closedEvents.push(r) });
  assert.equal(s.isAlive(), true);
  s.simulateCrash();
  assert.equal(s.isAlive(), false);
  assert.deepEqual(closedEvents, ["crashed"]);
  await s.close();
  await s.close();
  assert.equal(adapter.openSessionCount(), 0);
});

test("headed and storageState are recorded; launch failures surface as configured", async () => {
  const { adapter, open } = setup();
  const s = await open({ headed: true, storageState: { cookies: [], origins: [] } });
  assert.equal(s.options.headed, true);
  assert.deepEqual(s.options.storageState, { cookies: [], origins: [] });
  adapter.failNextLaunch("runtime_unavailable");
  await assert.rejects(open(), (e) => e.code === "runtime_unavailable");
});

test("page primitives work against the fake", async () => {
  const { open } = setup({ "https://app.test/login": { selectors: { "#u": "", "#go": "" }, text: "Welcome Admin" } });
  const s = await open();
  await s.goto("https://app.test/login");
  await s.fill("#u", "alice");
  await s.click("#go");
  assert.equal(await s.exists("#u"), true);
  assert.equal(await s.exists("#nope"), false);
  assert.equal(await s.containsText("Welcome"), true);
  assert.deepEqual(await s.storageState(), { cookies: [], origins: [] });
  assert.ok(Buffer.isBuffer(await s.screenshot()));
});
