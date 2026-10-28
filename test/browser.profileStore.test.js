import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, currentOrgId } from "../src/db.js";
import { createTestProject, cleanupTestProject } from "./helpers/testProject.js";
import {
  importProfile, removeProfile, listProfiles, getProfile,
  setSavedStateProbe, registerProfileRemovalHook,
} from "../src/browser/profileStore.js";
import { writeAuditEvent, AUDIT_ACTORS } from "../src/browser/audit.js";

const PROJECT = "bsm_profile_store_fixture";
const OTHER = "bsm_profile_store_other";

const yaml = (extra = {}) => JSON.stringify({
  profile_id: "staging-admin",
  environment: "staging",
  base_url: "https://staging.example.test",
  allowed_origins: ["https://staging.example.test"],
  auth: { mode: "fresh_login" },
  login: {
    url: "https://staging.example.test/login",
    username_selector: "#u", password_selector: "#p", submit_selector: "#s",
    username_secret: "STAGING_USER", password_secret: "STAGING_PASS",
  },
  verify: { url: "https://staging.example.test/admin", selector: "#bar" },
  ...extra,
});

let project;
let other;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  project = await createTestProject(PROJECT);
  other = await createTestProject(OTHER);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM browser_profiles WHERE project_id = ANY($1)`, [[project.id, other.id]]);
  await pool.query(`DELETE FROM browser_sessions WHERE project_id = ANY($1)`, [[project.id, other.id]]);
  await pool.query(`DELETE FROM browser_audit_events WHERE project_id = ANY($1)`, [[project.id, other.id]]);
  setSavedStateProbe(null);
  registerProfileRemovalHook(null);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(OTHER);
  await pool.end();
});

test("migration 0018 creates the four browser tables", async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'browser\\_%' ORDER BY 1`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ["browser_audit_events", "browser_profiles", "browser_session_artifacts", "browser_sessions"]) {
    assert.ok(names.includes(t), t);
  }
});

test("import stores the profile; re-import replaces it", async () => {
  const first = await importProfile(PROJECT, yaml());
  assert.equal(first.replaced, false);
  const second = await importProfile(PROJECT, yaml({ environment: "local" }));
  assert.equal(second.replaced, true);
  const row = await getProfile(project.id, "staging-admin");
  assert.equal(row.environment, "local");
  assert.equal(row.auth_mode, "fresh_login");
  assert.deepEqual(row.allowed_origins, ["https://staging.example.test"]);
  assert.equal(row.definition.login.password_secret, "STAGING_PASS");
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM browser_profiles WHERE project_id = $1`, [project.id]);
  assert.equal(rows[0].n, 1);
});

test("import into an unknown project throws project_not_found", async () => {
  await assert.rejects(importProfile("bsm_no_such_project", yaml()), (e) => e.code === "project_not_found");
});

test("a rejected profile writes nothing", async () => {
  await assert.rejects(importProfile(PROJECT, yaml({ environment: "production" })), (e) => e.code === "environment_not_allowed");
  assert.equal(await getProfile(project.id, "staging-admin"), null);
});

test("the same profile_id can exist in two projects", async () => {
  await importProfile(PROJECT, yaml());
  await importProfile(OTHER, yaml());
  assert.equal((await listProfiles(PROJECT)).length, 1);
  assert.equal((await listProfiles(OTHER)).length, 1);
});

test("listProfiles returns exactly the REQ-003 fields and nothing else (AC-002)", async () => {
  await importProfile(PROJECT, yaml());
  const [p] = await listProfiles(PROJECT);
  assert.deepEqual(Object.keys(p).sort(), [
    "allowed_origins", "auth_mode", "base_url", "environment", "has_saved_state", "profile_id",
  ]);
  assert.equal(p.has_saved_state, false);
  const json = JSON.stringify(p);
  assert.doesNotMatch(json, /STAGING_PASS|STAGING_USER|state_path|cookie/i);
});

test("has_saved_state comes from the registered probe and is always boolean", async () => {
  await importProfile(PROJECT, yaml());
  const seen = [];
  setSavedStateProbe(async (q) => { seen.push(q); return "yes"; });
  const [p] = await listProfiles(PROJECT);
  assert.equal(p.has_saved_state, true);
  assert.equal(seen[0].profileId, "staging-admin");
  assert.equal(seen[0].projectId, project.id);
});

test("listProfiles on an unknown project throws project_not_found", async () => {
  await assert.rejects(listProfiles("bsm_no_such_project"), (e) => e.code === "project_not_found");
});

test("remove deletes the profile; unknown profile throws profile_not_found", async () => {
  await importProfile(PROJECT, yaml());
  const r = await removeProfile(PROJECT, "staging-admin");
  assert.equal(r.removed, true);
  assert.equal(await getProfile(project.id, "staging-admin"), null);
  await assert.rejects(removeProfile(PROJECT, "staging-admin"), (e) => e.code === "profile_not_found");
});

test("remove closes live sessions of that profile first, and leaves other profiles' alone", async () => {
  await importProfile(PROJECT, yaml());
  await pool.query(
    `INSERT INTO browser_sessions (id, project_id, profile_id, status, auth_mode)
     VALUES ('s_live', $1, 'staging-admin', 'READY', 'fresh_login'),
            ('s_done', $1, 'staging-admin', 'CLOSED', 'fresh_login'),
            ('s_else', $1, 'other-profile', 'READY', 'fresh_login')`,
    [project.id]
  );
  const calls = [];
  registerProfileRemovalHook(async (c) => { calls.push(c); });
  const r = await removeProfile(PROJECT, "staging-admin");
  assert.equal(r.sessions_closed, 1);
  assert.deepEqual(calls.map((c) => c.profileId), ["staging-admin"]);
  const { rows } = await pool.query(`SELECT id, status, closed_at FROM browser_sessions WHERE project_id = $1 ORDER BY id`, [project.id]);
  const by = Object.fromEntries(rows.map((x) => [x.id, x]));
  assert.equal(by.s_live.status, "CLOSED");
  assert.ok(by.s_live.closed_at);
  assert.equal(by.s_else.status, "READY");
});

test("import and remove are audited with actor cli and no secret content", async () => {
  await importProfile(PROJECT, yaml(), { ctx: { surface: "cli", correlationId: "corr-1" } });
  await removeProfile(PROJECT, "staging-admin", { ctx: { surface: "cli", correlationId: "corr-2" } });
  const { rows } = await pool.query(
    `SELECT event_type, actor, result, correlation_id, data FROM browser_audit_events
      WHERE project_id = $1 ORDER BY id`, [project.id]);
  assert.deepEqual(rows.map((r) => [r.event_type, r.actor, r.result, r.correlation_id]), [
    ["profile_imported", "cli", "ok", "corr-1"],
    ["profile_removed", "cli", "ok", "corr-2"],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /STAGING_PASS/);
});

test("audit writer: actor must be a known surface; correlation id is generated when absent", async () => {
  assert.deepEqual([...AUDIT_ACTORS].sort(), ["cli", "http", "mcp"]);
  await assert.rejects(
    writeAuditEvent({ projectId: project.id, eventType: "x", result: "ok", ctx: { surface: "web" } }),
    /actor/
  );
  const row = await writeAuditEvent({ projectId: project.id, sessionId: "s1", eventType: "tool_call", result: "rejected", ctx: { surface: "mcp" }, data: { reason: "origin_blocked" } });
  assert.equal(row.actor, "mcp");
  assert.ok(row.correlation_id.length >= 8);
  assert.equal(row.session_id, "s1");
});

test("audit rows are append-only at the database: UPDATE is refused", async () => {
  const row = await writeAuditEvent({ projectId: project.id, eventType: "tool_call", result: "ok", ctx: { surface: "mcp" } });
  await assert.rejects(pool.query(`UPDATE browser_audit_events SET result = 'x' WHERE id = $1`, [row.id]), /append-only/);
});

test("deleting a project cascades to profiles, sessions and audit rows", async () => {
  const p = await createTestProject("bsm_cascade_fixture");
  await importProfile("bsm_cascade_fixture", yaml());
  await writeAuditEvent({ projectId: p.id, eventType: "tool_call", result: "ok", ctx: { surface: "cli" } });
  await cleanupTestProject("bsm_cascade_fixture");
  for (const t of ["browser_profiles", "browser_audit_events"]) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE project_id = $1`, [p.id]);
    assert.equal(rows[0].n, 0, t);
  }
  assert.ok(await currentOrgId());
});
