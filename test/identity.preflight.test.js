import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { cleanupTestProject, insertTestFile, insertTestSymbol } from "./helpers/testProject.js";
import { createGitRepo, writeRepoFile, commitAll, cleanupGitRepo } from "./helpers/gitFixture.js";

// UI intelligence, Increment 1A, phase 1A-5 (REQ-027): the project-level
// identity preflight index_project runs once per job, right after
// reconcileIdentity() and before the (not-yet-built) UI relation post-pass.
// See docs/specs/ui-intelligence/contracts.md "Phase 1A-5" for the handoff
// shape and the UI_IDENTITY_INCOMPLETE diagnostic shape decision this test
// asserts against.

const PROJECT = "identity_preflight_fixture";
let repoDir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repoDir = createGitRepo();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repoDir) cleanupGitRepo(repoDir);
  await pool.end();
});

test("identity already complete: preflight runs, finds nothing to do, no diagnostic", async () => {
  writeRepoFile(repoDir, "a.js", "function a() { return 'a'.repeat(40) + 'padding for length here'; }");
  writeRepoFile(repoDir, "b.js", "function b() { return 'b'.repeat(40) + 'padding for length here'; }");
  commitAll(repoDir, "first");

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.identityPreflight, "identityPreflight should be present when ui.enabled");
  assert.equal(stats.identityPreflight.complete, true);
  assert.equal(stats.identityPreflight.backfillRan, false);
  assert.equal(stats.identityPreflight.backfillResult, null);
  assert.deepEqual(stats.identityPreflight.diagnostics, []);
});

test("unlinked symbols get backfilled in one pass (once per job, not per file)", async () => {
  const project = await getProject(PROJECT);

  // Simulate symbols that predate the identity plane -- same trick
  // test/identity.indexer.test.js uses -- across two files, so a real,
  // multi-file backfill run is exercised in one preflight call.
  const fileA = await insertTestFile(project.id, "legacy/one.js");
  const fileB = await insertTestFile(project.id, "legacy/two.js");
  const longBody = (label) => `function ${label}() { return '${label}'.repeat(20) + 'padding to reach the sixty four character fingerprint floor'; }`;
  await insertTestSymbol(project.id, fileA, { name: "legacyOne", body: longBody("legacyOne") });
  await insertTestSymbol(project.id, fileB, { name: "legacyTwo", body: longBody("legacyTwo") });

  const logLines = [];
  const stats = await indexProject(PROJECT, repoDir, (m) => logLines.push(m));
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const pf = stats.identityPreflight;
  assert.ok(pf, "identityPreflight should be present");
  assert.equal(pf.backfillRan, true);
  assert.equal(pf.complete, true);
  assert.deepEqual(pf.diagnostics, []);
  // Both legacy files were caught in the same backfill call -- one job, not
  // one preflight invocation per file.
  assert.ok(pf.backfillResult.files >= 2, JSON.stringify(pf.backfillResult));
  assert.equal(logLines.filter((l) => l.startsWith("Identity preflight:")).length, 1,
    "the preflight's own log line should appear exactly once per job");

  const linked = await pool.query(
    `SELECT entity_id FROM symbols WHERE project_id = $1 AND name IN ('legacyOne','legacyTwo')`,
    [project.id]
  );
  assert.ok(linked.rows.every((r) => r.entity_id), "both legacy symbols should now have an entity_id");
});

test("backfill failure leaves identity incomplete, emits UI_IDENTITY_INCOMPLETE, and the job still completes", async () => {
  const project = await getProject(PROJECT);

  // Force a genuine, reproducible backfillProjectIdentity failure: two
  // symbol rows sharing one pre-set (non-NULL) symbol_key with entity_id
  // still NULL. backfillProjectIdentity's entity-creation INSERT selects
  // both in one statement and upserts on (project_id, kind, natural_key) --
  // Postgres rejects a single INSERT ... ON CONFLICT DO UPDATE affecting the
  // same conflict target twice, so the call throws for real, not mocked.
  const file = await insertTestFile(project.id, "legacy/collide.js");
  const longBody = (label) => `function ${label}() { return '${label}'.repeat(20) + 'padding to reach the sixty four character fingerprint floor'; }`;
  const s1 = await insertTestSymbol(project.id, file, { name: "collideOne", body: longBody("collideOne") });
  const s2 = await insertTestSymbol(project.id, file, { name: "collideTwo", body: longBody("collideTwo") });
  await pool.query(`UPDATE symbols SET symbol_key = 'legacy/collide.js#function:collide' WHERE id = ANY($1)`, [[s1, s2]]);

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.failed, 0, JSON.stringify(stats), "overall index_project job must still complete");

  const pf = stats.identityPreflight;
  assert.ok(pf, "identityPreflight should be present");
  assert.equal(pf.backfillRan, true);
  assert.equal(pf.complete, false);
  assert.equal(pf.diagnostics.length, 1);
  const diag = pf.diagnostics[0];
  assert.deepEqual(Object.keys(diag).sort(), ["affected_feature", "code", "message", "recommended_action", "severity"]);
  assert.equal(diag.code, "UI_IDENTITY_INCOMPLETE");
  assert.equal(diag.severity, "warning");
  assert.equal(diag.affected_feature, "ui_relations");
  assert.equal(diag.recommended_action, "waycontext backfill-identity");
  assert.match(diag.message, /identity/i);

  const still = await pool.query(
    `SELECT entity_id FROM symbols WHERE id = ANY($1)`,
    [[s1, s2]]
  );
  assert.ok(still.rows.every((r) => r.entity_id === null), "the colliding pair should remain unlinked");

  // Clean up the colliding rows so they don't poison later runs.
  await pool.query(`DELETE FROM symbols WHERE id = ANY($1)`, [[s1, s2]]);
  await pool.query(`DELETE FROM files WHERE id = $1`, [file]);
});

test("config.uiEnabled = false: preflight does not run at all, even with unlinked symbols present", async () => {
  const project = await getProject(PROJECT);
  const file = await insertTestFile(project.id, "legacy/gated.js");
  await insertTestSymbol(project.id, file, {
    name: "gated",
    body: "function gated() { return 'gated'.repeat(20) + 'padding to reach the sixty four character fingerprint floor'; }",
  });

  const prevEnabled = config.uiEnabled;
  config.uiEnabled = false;
  try {
    const stats = await indexProject(PROJECT, repoDir);
    assert.equal(stats.failed, 0, JSON.stringify(stats));
    assert.equal(stats.identityPreflight, null);
  } finally {
    config.uiEnabled = prevEnabled;
  }

  const row = await pool.query(`SELECT entity_id FROM symbols WHERE project_id = $1 AND file_id = $2`, [project.id, file]);
  assert.equal(row.rows[0].entity_id, null, "backfill must not have run while the gate was off");
});
