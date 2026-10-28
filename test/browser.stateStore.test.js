import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, initDb } from "../src/db.js";
import { createTestProject, cleanupTestProject } from "./helpers/testProject.js";
import {
  saveStorageState, loadStorageState, hasSavedState, deleteSavedState, writeEvidenceFile,
  resolveStorageRef, defaultStateDir, recordArtifact, listArtifacts,
} from "../src/browser/stateStore.js";
import { redact, clearSensitive } from "../src/browser/secrets.js";
import { setSavedStateProbe, importProfile, listProfiles } from "../src/browser/profileStore.js";
import { installSavedStateProbe } from "../src/browser/ops.js";
import { config } from "../src/config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "bsm_state_store_fixture";
const scope = { orgId: 1, project: PROJECT, profileId: "staging-admin" };
const COOKIE_SENTINEL = "fake-cookie-sentinel-5d2e81";
const STATE = {
  cookies: [{ name: "sid", value: COOKIE_SENTINEL, domain: "staging.example.test", path: "/" }],
  origins: [],
};

let dir;
let project;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  project = await createTestProject(PROJECT);
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-state-"));
  clearSensitive();
  setSavedStateProbe(null);
  await pool.query(`DELETE FROM browser_sessions WHERE project_id = $1`, [project.id]);
  await pool.query(`DELETE FROM browser_profiles WHERE project_id = $1`, [project.id]);
});
after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("default state dir is ~/.local/state/waycontext/browser and sits outside the repo", () => {
  assert.equal(defaultStateDir(), config.browserStateDir);
  assert.ok(config.browserStateDir.endsWith(path.join(".local", "state", "waycontext", "browser")) || process.env.BROWSER_STATE_DIR);
  assert.ok(!path.resolve(config.browserStateDir).startsWith(REPO_ROOT + path.sep));
});

test("saveStorageState writes <org>/<project>/<profile>/ with file mode 0600 and returns an opaque ref", async () => {
  const ref = await saveStorageState(scope, STATE, { baseDir: dir });
  const file = resolveStorageRef(ref, { baseDir: dir });
  assert.equal(file, path.join(dir, "1", PROJECT, "staging-admin", "storage-state.json"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, "directory is owner-only");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), STATE);
  assert.ok(!path.resolve(file).startsWith(REPO_ROOT + path.sep));
  assert.ok(!ref.includes(dir), "ref holds no absolute path");
  assert.ok(!ref.includes(COOKIE_SENTINEL));
});

test("overwriting keeps mode 0600 and replaces content", async () => {
  await saveStorageState(scope, STATE, { baseDir: dir });
  const ref = await saveStorageState(scope, { cookies: [], origins: [] }, { baseDir: dir });
  const file = resolveStorageRef(ref, { baseDir: dir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadStorageState(scope, { baseDir: dir }), { cookies: [], origins: [] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["storage-state.json"], "no temp file left behind");
});

test("loadStorageState returns the state and registers cookie values for redaction", async () => {
  await saveStorageState(scope, STATE, { baseDir: dir });
  clearSensitive();
  assert.deepEqual(loadStorageState(scope, { baseDir: dir }), STATE);
  assert.equal(redact(`got ${COOKIE_SENTINEL}`), "got [REDACTED]");
});

test("loadStorageState without a file throws state_missing and no content", () => {
  assert.equal(hasSavedState(scope, { baseDir: dir }), false);
  assert.throws(() => loadStorageState(scope, { baseDir: dir }), (e) => e.code === "state_missing" && /browser-login|fresh/.test(e.message));
});

test("state is scoped per org, project and profile", async () => {
  await saveStorageState(scope, STATE, { baseDir: dir });
  assert.equal(hasSavedState(scope, { baseDir: dir }), true);
  assert.equal(hasSavedState({ ...scope, profileId: "other" }, { baseDir: dir }), false);
  assert.equal(hasSavedState({ ...scope, project: "other" }, { baseDir: dir }), false);
  assert.equal(hasSavedState({ ...scope, orgId: 2 }, { baseDir: dir }), false);
});

test("deleteSavedState removes the file", async () => {
  await saveStorageState(scope, STATE, { baseDir: dir });
  assert.equal(deleteSavedState(scope, { baseDir: dir }), true);
  assert.equal(hasSavedState(scope, { baseDir: dir }), false);
  assert.equal(deleteSavedState(scope, { baseDir: dir }), false);
});

test("path traversal in scope segments is rejected", async () => {
  for (const bad of [{ profileId: ".." }, { project: "" }, { project: "." }, { orgId: ".." }]) {
    await assert.rejects(saveStorageState({ ...scope, ...bad }, STATE, { baseDir: dir }), (e) => e.code === "invalid_storage_ref", JSON.stringify(bad));
  }
  // Separators are percent-encoded into one harmless segment, never a path break.
  const ref = await saveStorageState({ ...scope, project: "../x" }, STATE, { baseDir: dir });
  assert.ok(resolveStorageRef(ref, { baseDir: dir }).startsWith(dir + path.sep));
  assert.equal(path.dirname(path.dirname(path.dirname(resolveStorageRef(ref, { baseDir: dir })))), path.join(dir, "1"));
});

test("refuses a state dir inside a git working tree (an indexed project root)", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  await assert.rejects(saveStorageState(scope, STATE, { baseDir: path.join(repo, "state") }), (e) => e.code === "invalid_state_dir");
  assert.equal(fs.existsSync(path.join(repo, "state")), false, "nothing created inside the tree");
});

test("refuses a state dir inside an explicitly forbidden root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bsm-root-"));
  await assert.rejects(
    saveStorageState(scope, STATE, { baseDir: path.join(root, "s"), forbiddenRoots: [root] }),
    (e) => e.code === "invalid_state_dir",
  );
  await assert.rejects(
    saveStorageState(scope, STATE, { baseDir: root, forbiddenRoots: [root] }),
    (e) => e.code === "invalid_state_dir",
  );
});

test("writeEvidenceFile stores a 0600 screenshot and returns a screenshot ref", async () => {
  const ref = await writeEvidenceFile(scope, "sess123", "shot-1.png", Buffer.from([1, 2, 3]), { baseDir: dir });
  assert.ok(ref.startsWith("screenshot:"));
  const file = resolveStorageRef(ref, { baseDir: dir });
  assert.equal(file, path.join(dir, "1", PROJECT, "staging-admin", "evidence", "sess123", "shot-1.png"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(writeEvidenceFile(scope, "sess123", "../../x.png", Buffer.from([1]), { baseDir: dir }), (e) => e.code === "invalid_storage_ref");
});

test("resolveStorageRef rejects malformed or escaping refs", () => {
  for (const bad of ["", "nope", "storage_state:", "other:1/a/b/c", "storage_state:../../etc/passwd", "storage_state:/abs/x",
    "storage_state:1/p/q/../../../x", "screenshot:1/p/q/evidence/s/../../../../x", "storage_state:1/p/q/other.json"]) {
    assert.throws(() => resolveStorageRef(bad, { baseDir: dir }), (e) => e.code === "invalid_storage_ref", bad);
  }
});

test("artifact rows hold only the opaque ref, never content", async () => {
  await pool.query(
    `INSERT INTO browser_sessions (id, project_id, profile_id, status, auth_mode) VALUES ('s-p2', $1, 'staging-admin', 'READY', 'fresh_login')`,
    [project.id],
  );
  const ref = await saveStorageState(scope, STATE, { baseDir: dir });
  const row = await recordArtifact({ sessionId: "s-p2", artifactType: "storage_state", storageRef: ref });
  assert.equal(row.storage_ref, ref);
  const rows = await listArtifacts("s-p2");
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(COOKIE_SENTINEL));
  await assert.rejects(recordArtifact({ sessionId: "s-p2", artifactType: "cookie", storageRef: ref }), /artifact_type|check/i);
  await assert.rejects(recordArtifact({ sessionId: "s-p2", artifactType: "screenshot", storageRef: ref }), (e) => e.code === "invalid_storage_ref");
});

test("installSavedStateProbe makes has_saved_state real in browser_profile list", async () => {
  await importProfile(PROJECT, JSON.stringify({
    profile_id: "staging-admin", environment: "staging", base_url: "https://staging.example.test",
    allowed_origins: ["https://staging.example.test"], auth: { mode: "saved_state" },
    verify: { url: "https://staging.example.test/admin", selector: "#bar" },
  }));
  installSavedStateProbe({ baseDir: dir });
  assert.equal((await listProfiles(PROJECT))[0].has_saved_state, false);
  const { currentOrgId } = await import("../src/db.js");
  const orgId = await currentOrgId();
  await saveStorageState({ orgId, project: PROJECT, profileId: "staging-admin" }, STATE, { baseDir: dir });
  assert.equal((await listProfiles(PROJECT))[0].has_saved_state, true);
});
