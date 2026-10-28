import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyConfigChanges, ConfigWriteError } from "../src/configWriter.js";

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-writer-"));
  const f = path.join(dir, "nested", "config.json");
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return f;
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function status(fn, code) {
  assert.throws(fn, (e) => e instanceof ConfigWriteError && e.status === code);
}

test("writes and creates dir with mode 0600", () => {
  const f = tmpFile();
  const r = applyConfigChanges({ set: { ORG_SLUG: "acme" } }, { configPath: f });
  assert.deepEqual(read(f), { ORG_SLUG: "acme" });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(r, { written: ["ORG_SLUG"], removed: [] });
});

test("preserves unknown keys", () => {
  const f = tmpFile('{"CUSTOM":1}');
  applyConfigChanges({ set: { ORG_SLUG: "a" } }, { configPath: f });
  assert.equal(read(f).CUSTOM, 1);
});

test('booleans stored as "1"/"0"', () => {
  const f = tmpFile();
  applyConfigChanges({ set: { HISTORY_ENABLED: false } }, { configPath: f });
  assert.equal(read(f).HISTORY_ENABLED, "0");
  applyConfigChanges({ set: { HISTORY_ENABLED: "true" } }, { configPath: f });
  assert.equal(read(f).HISTORY_ENABLED, "1");
});

test("numbers are stored as strings", () => {
  const f = tmpFile();
  applyConfigChanges({ set: { EMBEDDING_DIM: 512 } }, { configPath: f });
  assert.equal(read(f).EMBEDDING_DIM, "512");
});

test("unset removes key", () => {
  const f = tmpFile('{"ORG_SLUG":"a","X":1}');
  const r = applyConfigChanges({ unset: ["ORG_SLUG"] }, { configPath: f });
  assert.deepEqual(read(f), { X: 1 });
  assert.deepEqual(r.removed, ["ORG_SLUG"]);
});

test("unknown key -> 400", () => {
  const f = tmpFile();
  assert.throws(
    () => applyConfigChanges({ set: { NOPE: 1 } }, { configPath: f }),
    (e) => e.status === 400 && e.key === "NOPE",
  );
  status(() => applyConfigChanges({ unset: ["NOPE"] }, { configPath: f }), 400);
});

test("secret key -> 403 and file unchanged", () => {
  const f = tmpFile('{"A":1}');
  const before = fs.readFileSync(f);
  status(() => applyConfigChanges({ set: { OPENAI_API_KEY: "x" } }, { configPath: f }), 403);
  status(() => applyConfigChanges({ unset: ["OPENAI_API_KEY"] }, { configPath: f }), 403);
  status(() => applyConfigChanges({ set: { WAYCONTEXT_BROWSER_SECRET_FOO: "x" } }, { configPath: f }), 403);
  status(() => applyConfigChanges({ unset: ["WAYCONTEXT_BROWSER_SECRET_FOO"] }, { configPath: f }), 403);
  assert.deepEqual(fs.readFileSync(f), before);
});

test("envOnly key -> 403", () => {
  const f = tmpFile();
  status(() => applyConfigChanges({ set: { WAYCONTEXT_CONFIG: "x" } }, { configPath: f }), 403);
  status(() => applyConfigChanges({ unset: ["WAYCONTEXT_CONFIG"] }, { configPath: f }), 403);
});

test("bad number -> 400", () => {
  const f = tmpFile();
  status(() => applyConfigChanges({ set: { EMBEDDING_DIM: "abc" } }, { configPath: f }), 400);
  status(() => applyConfigChanges({ set: { EMBEDDING_DIM: "" } }, { configPath: f }), 400);
  status(() => applyConfigChanges({ set: { EMBEDDING_DIM: Infinity } }, { configPath: f }), 400);
});

test("bad enum -> 400", () => {
  const f = tmpFile();
  status(() => applyConfigChanges({ set: { EMBEDDING_PROVIDER: "cohere" } }, { configPath: f }), 400);
});

test("empty string -> 400 and a bad key blocks the whole batch", () => {
  const f = tmpFile();
  status(() => applyConfigChanges({ set: { ORG_SLUG: "" } }, { configPath: f }), 400);
  status(() => applyConfigChanges({ set: { ORG_SLUG: "a", NOPE: 1 } }, { configPath: f }), 400);
  assert.equal(fs.existsSync(f), false);
});

test("malformed or non-object existing file -> 409, bytes untouched", () => {
  for (const bad of ["{nope", "[1]", "null"]) {
    const f = tmpFile(bad);
    status(() => applyConfigChanges({ set: { ORG_SLUG: "a" } }, { configPath: f }), 409);
    assert.equal(fs.readFileSync(f, "utf8"), bad);
  }
});

test("atomic: no tmp file left behind", () => {
  const f = tmpFile();
  applyConfigChanges({ set: { ORG_SLUG: "a" } }, { configPath: f });
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith(".tmp")), []);
});
