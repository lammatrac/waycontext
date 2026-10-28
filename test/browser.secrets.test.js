import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSecret, hasSecret, registerSensitive, redact, redactDeep, redactError, clearSensitive,
  isSensitiveCookieValue, createSensitiveScope,
} from "../src/browser/secrets.js";
import { browserSecretEnvName } from "../src/config.js";

// Fake names and values only; nothing here is a real credential.
const NAME = "BSM_TEST_FAKE";
const VAR = `WAYCONTEXT_BROWSER_SECRET_${NAME}`;
const VALUE = "fake-value-7f3a9c-not-real";

beforeEach(() => {
  delete process.env[VAR];
  delete process.env.BSM_TEST_UNPREFIXED;
  clearSensitive();
});

test("browserSecretEnvName builds the prefixed variable name", () => {
  assert.equal(browserSecretEnvName(NAME), VAR);
});

test("resolveSecret reads WAYCONTEXT_BROWSER_SECRET_<NAME>", () => {
  process.env[VAR] = VALUE;
  assert.equal(resolveSecret(NAME), VALUE);
  assert.equal(hasSecret(NAME), true);
});

test("a missing secret throws secret_missing naming the variable, not any value", () => {
  assert.equal(hasSecret(NAME), false);
  assert.throws(() => resolveSecret(NAME), (e) => e.code === "secret_missing" && e.message.includes(VAR));
});

test("an empty secret counts as missing", () => {
  process.env[VAR] = "";
  assert.throws(() => resolveSecret(NAME), (e) => e.code === "secret_missing");
});

test("no other env var is resolvable", () => {
  process.env.BSM_TEST_UNPREFIXED = VALUE;
  assert.throws(() => resolveSecret("BSM_TEST_UNPREFIXED"), (e) => e.code === "secret_missing");
  for (const bad of [VAR, "lower", "A-B", "", "../x", "PATH "]) {
    assert.throws(() => resolveSecret(bad), (e) => e.code === "invalid_secret_name", bad);
  }
});

test("redact removes every resolved secret value from text", () => {
  process.env[VAR] = VALUE;
  resolveSecret(NAME);
  assert.equal(redact(`login with ${VALUE} failed; again ${VALUE}`), "login with [REDACTED] failed; again [REDACTED]");
});

test("redact removes registered sensitive values such as cookie values", () => {
  registerSensitive("cookie-sentinel-123456");
  assert.equal(redact("Cookie: sid=cookie-sentinel-123456"), "Cookie: sid=[REDACTED]");
});

test("redact ignores values too short to be a real secret", () => {
  registerSensitive("ab");
  assert.equal(redact("abc about"), "abc about");
});

test("redactDeep walks objects and arrays without mutating the input", () => {
  registerSensitive(VALUE);
  const input = { a: `x ${VALUE}`, b: [VALUE, 1, null], c: { d: VALUE } };
  const out = redactDeep(input);
  assert.deepEqual(out, { a: "x [REDACTED]", b: ["[REDACTED]", 1, null], c: { d: "[REDACTED]" } });
  assert.equal(input.a, `x ${VALUE}`);
});

test("redactError returns a clean error that keeps the code", async () => {
  const { BrowserError } = await import("../src/browser/errors.js");
  registerSensitive(VALUE);
  const e = redactError(new BrowserError("login_failed", `typed ${VALUE}`));
  assert.equal(e.code, "login_failed");
  assert.ok(!e.message.includes(VALUE));
  assert.ok(!(e.stack ?? "").includes(VALUE));
});

// ---- cookie values: filtered and session-scoped (review fix 2026-10-28) ------------

test("only long or mixed letter+digit cookie values count as sensitive; ordinary words do not", () => {
  for (const v of ["staging", "admin", "true", "false", "en-US", "1234567", "dark-mode", "", null, 42]) {
    assert.equal(isSensitiveCookieValue(v), false, String(v));
  }
  for (const v of ["fake-session-cookie-0001", "abcdefghijklmnop", "a1b2c3d4", "Zx9Q7wLm"]) {
    assert.equal(isSensitiveCookieValue(v), true, v);
  }
});

test("a sensitive scope registers cookie values for redaction and forgets them on dispose", () => {
  const sc = createSensitiveScope();
  sc.addCookies([{ name: "env", value: "staging" }, { name: "sid", value: "fake-session-cookie-0001" }, null]);
  assert.equal(redact("env=staging sid=fake-session-cookie-0001"), "env=staging sid=[REDACTED]");
  sc.dispose();
  assert.equal(redact("sid=fake-session-cookie-0001"), "sid=fake-session-cookie-0001");
  sc.dispose(); // idempotent
});

test("disposing one scope keeps values another scope or a resolved secret still holds", () => {
  process.env[VAR] = VALUE;
  resolveSecret(NAME);
  const a = createSensitiveScope();
  const b = createSensitiveScope();
  a.add(VALUE);
  a.add("fake-shared-cookie-777");
  b.add("fake-shared-cookie-777");
  a.dispose();
  assert.equal(redact(`${VALUE} fake-shared-cookie-777`), "[REDACTED] [REDACTED]");
  b.dispose();
  assert.equal(redact(`${VALUE} fake-shared-cookie-777`), "[REDACTED] fake-shared-cookie-777");
});

test("redact stays longest-first as values come and go (cached order is invalidated)", () => {
  const sc = createSensitiveScope();
  sc.add("fake-cookie-abcdefgh");
  assert.equal(redact("x fake-cookie-abcdefgh-longer"), "x [REDACTED]-longer");
  sc.add("fake-cookie-abcdefgh-longer");
  assert.equal(redact("x fake-cookie-abcdefgh-longer"), "x [REDACTED]");
  sc.dispose();
  assert.equal(redact("x fake-cookie-abcdefgh-longer"), "x fake-cookie-abcdefgh-longer");
});
