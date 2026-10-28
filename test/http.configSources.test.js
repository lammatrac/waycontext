// /v1/config source attribution through the real boot path: config.js folds the
// cwd .env into process.env at import, and the report must still name that file
// rather than "environment". Run in a child process so the cwd and environment
// are controlled without touching this test runner's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HTTP_JS = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "http.js"),
).href;

const CHILD = `
const { createServer } = await import(${JSON.stringify(HTTP_JS)});
const server = createServer({ listProjects: async () => [] });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const res = await fetch("http://127.0.0.1:" + server.address().port + "/v1/config");
const body = await res.json();
const pick = (k) => { const r = body.settings.find((s) => s.key === k); return { value: r.value, source: r.source }; };
process.stdout.write(JSON.stringify({ status: res.status, ORG_SLUG: pick("ORG_SLUG"), MODULE_DEPTH: pick("MODULE_DEPTH") }));
await new Promise((r) => server.close(r));
process.exit(0);
`;

function runChild({ cwd, extraEnv = {} }) {
  const env = { ...process.env };
  delete env.ORG_SLUG;
  delete env.MODULE_DEPTH;
  delete env.WAYCONTEXT_IGNORE_DOTENV;
  delete env.WAYCONTEXT_SERVICE_INJECTED;
  Object.assign(env, extraEnv);
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd, env, encoding: "utf8",
  });
  return JSON.parse(out);
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wc-cfgsrc-"));
  const envFile = path.join(cwd, ".env");
  fs.writeFileSync(envFile, "ORG_SLUG=from-cwd-dotenv\n");
  return { cwd, envFile, configPath: path.join(cwd, "missing-config.json") };
}

test("a key loaded from the cwd .env is reported with that file as its source", () => {
  const { cwd, envFile, configPath } = fixture();
  try {
    const r = runChild({ cwd, extraEnv: { WAYCONTEXT_CONFIG: configPath } });
    assert.equal(r.status, 200);
    assert.equal(r.ORG_SLUG.value, "from-cwd-dotenv");
    assert.equal(r.ORG_SLUG.source, envFile);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a real environment variable is still reported as environment", () => {
  const { cwd, configPath } = fixture();
  try {
    const r = runChild({ cwd, extraEnv: { WAYCONTEXT_CONFIG: configPath, MODULE_DEPTH: "3" } });
    assert.equal(r.MODULE_DEPTH.value, "3");
    assert.equal(r.MODULE_DEPTH.source, "environment");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("WAYCONTEXT_IGNORE_DOTENV hides the cwd .env layer from the report", () => {
  const { cwd, configPath } = fixture();
  try {
    const r = runChild({ cwd, extraEnv: { WAYCONTEXT_CONFIG: configPath, WAYCONTEXT_IGNORE_DOTENV: "1" } });
    assert.equal(r.ORG_SLUG.value, "default");
    assert.equal(r.ORG_SLUG.source, "built-in default");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
