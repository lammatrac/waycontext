import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrigin, isOriginAllowed } from "../src/browser/origin.js";
import { BrowserError } from "../src/browser/errors.js";

// AC-001: exact scheme + host + port, after normalization. Nothing fuzzy.
const ALLOWED = ["https://staging.example.test"];

test("allows the same origin with a path or an explicit default port", () => {
  assert.equal(isOriginAllowed("https://staging.example.test/x", ALLOWED), true);
  assert.equal(isOriginAllowed("https://staging.example.test:443/x", ALLOWED), true);
  assert.equal(isOriginAllowed("https://STAGING.example.test/", ALLOWED), true);
});

test("rejects scheme, port, suffix and query-string lookalikes", () => {
  for (const url of [
    "http://staging.example.test",
    "https://staging.example.test:8443",
    "https://staging.example.test.evil.test",
    "https://evil.test/?u=staging.example.test",
    "https://evil.test/staging.example.test",
    "https://user@evil.test@staging.example.test.evil.test/",
    "https://xstaging.example.test",
  ]) {
    assert.equal(isOriginAllowed(url, ALLOWED), false, url);
  }
});

test("two entries differing only by port are distinct origins", () => {
  const allowed = ["http://localhost:3000"];
  assert.equal(isOriginAllowed("http://localhost:3000/a", allowed), true);
  assert.equal(isOriginAllowed("http://localhost:3001/a", allowed), false);
  assert.equal(isOriginAllowed("http://localhost/a", allowed), false);
});

test("non-http schemes and unparseable input are refused (default-deny)", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url", "", null, undefined, 42]) {
    assert.equal(isOriginAllowed(url, ["https://staging.example.test"]), false, String(url));
  }
  assert.equal(isOriginAllowed("https://a.test/", []), false);
});

test("normalizeOrigin returns the canonical origin", () => {
  assert.equal(normalizeOrigin("HTTPS://Staging.Example.Test:443"), "https://staging.example.test");
  assert.equal(normalizeOrigin("http://localhost:3000/"), "http://localhost:3000");
});

test("normalizeOrigin rejects wildcards, paths, credentials and odd schemes", () => {
  for (const bad of [
    "https://*.example.test", "*", "https://staging.example.test/admin",
    "https://staging.example.test?x=1", "https://a:b@staging.example.test",
    "ftp://staging.example.test", "staging.example.test", "https://staging.example.test#f",
  ]) {
    assert.throws(() => normalizeOrigin(bad), (e) => e instanceof BrowserError && e.code === "invalid_origin", bad);
  }
});
