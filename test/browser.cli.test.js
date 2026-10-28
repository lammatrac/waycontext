import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, initDb } from "../src/db.js";
import { createTestProject, cleanupTestProject } from "./helpers/testProject.js";
import { MANUAL_COMMANDS, OP_HELP } from "../src/completion.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PROJECT = "bsm_cli_fixture";
let dir;
let project;

const PROFILE = {
  profile_id: "staging-admin", environment: "staging",
  base_url: "https://staging.example.test", allowed_origins: ["https://staging.example.test"],
  auth: { mode: "saved_state" },
  verify: { url: "https://staging.example.test/admin", selector: "#bar" },
};

const write = (name, obj) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
  return f;
};
const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, EMBEDDING_PROVIDER: "none" } });

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  project = await createTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-cli-"));
});
after(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("browser-profile import stores the profile and prints a summary", async () => {
  const r = cli("browser-profile", "import", PROJECT, write("ok.yaml", PROFILE));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.profile_id, "staging-admin");
  assert.equal(out.replaced, false);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM browser_profiles WHERE project_id = $1`, [project.id]);
  assert.equal(rows[0].n, 1);
  const audit = await pool.query(`SELECT actor, event_type FROM browser_audit_events WHERE project_id = $1`, [project.id]);
  assert.deepEqual(audit.rows[0], { actor: "cli", event_type: "profile_imported" });
});

test("a production profile fails import with environment_not_allowed and a non-zero exit (AC-012)", () => {
  const r = cli("browser-profile", "import", PROJECT, write("prod.yaml", { ...PROFILE, profile_id: "prod", environment: "production" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /environment_not_allowed/);
});

test("an off-origin verify.url fails import (AC-001)", () => {
  const bad = { ...PROFILE, profile_id: "bad", verify: { ...PROFILE.verify, url: "https://evil.test/admin" } };
  const r = cli("browser-profile", "import", PROJECT, write("bad.yaml", bad));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /verify\.url/);
});

test("the browser_profile_list op works from the CLI", () => {
  const r = cli("browser_profile_list", PROJECT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].profile_id, "staging-admin");
});

test("browser-profile remove deletes it; a missing file or usage error exits non-zero", async () => {
  assert.notEqual(cli("browser-profile", "import", PROJECT, path.join(dir, "nope.yaml")).status, 0);
  assert.notEqual(cli("browser-profile").status, 0);
  const r = cli("browser-profile", "remove", PROJECT, "staging-admin");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).removed, true);
  const gone = cli("browser-profile", "remove", PROJECT, "staging-admin");
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /profile_not_found/);
});

test("completion/help knows browser-profile and the browser op", () => {
  assert.ok(MANUAL_COMMANDS.some((c) => c.name === "browser-profile"));
  assert.ok(OP_HELP.browser_profile_list);
});

test("browser-login --timeout beyond the timer limit is a usage error, not a 1 ms timeout", () => {
  const r = cli("browser-login", PROJECT, "whatever", "--timeout=2147484");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--timeout must be between 1 and 2147483 seconds/);
});
