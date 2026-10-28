import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSecret, hasSecret, registerSensitive, redact, redactDeep, redactError, clearSensitive,
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
