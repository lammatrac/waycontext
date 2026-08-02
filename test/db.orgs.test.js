import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  pool, initDb, currentOrgId, getOrCreateProject, getProject,
  listProjects, deleteProject,
} from "../src/db.js";

const NAME = "orgs_fixture_project";
const OTHER_ORG = "orgs_fixture_other";

let defaultOrgId;
let otherOrgId;

async function cleanup() {
  await pool.query(`DELETE FROM projects WHERE name = $1`, [NAME]);
  await pool.query(`DELETE FROM orgs WHERE slug = $1`, [OTHER_ORG]);
}

before(async () => {
  await initDb();
  await cleanup();
  defaultOrgId = await currentOrgId();
  const res = await pool.query(
    `INSERT INTO orgs (slug, name) VALUES ($1, $1) RETURNING id`,
    [OTHER_ORG]
  );
  otherOrgId = res.rows[0].id;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("currentOrgId resolves the configured org and is memoized", async () => {
  assert.ok(Number.isInteger(defaultOrgId));
  assert.equal(await currentOrgId(), defaultOrgId);
  const res = await pool.query(`SELECT slug FROM orgs WHERE id = $1`, [defaultOrgId]);
  assert.equal(res.rows[0].slug, "default");
});

test("every existing project was backfilled with an org", async () => {
  const res = await pool.query(`SELECT count(*)::int AS n FROM projects WHERE org_id IS NULL`);
  assert.equal(res.rows[0].n, 0);
});

test("getOrCreateProject stamps the current org", async () => {
  const project = await getOrCreateProject(NAME, "/tmp/orgs-fixture");
  assert.equal(project.org_id, defaultOrgId);
});

test("the same project name can exist in two different orgs", async () => {
  await getOrCreateProject(NAME, "/tmp/orgs-fixture");
  const other = await getOrCreateProject(NAME, "/tmp/orgs-fixture-other", otherOrgId);
  assert.equal(other.org_id, otherOrgId);

  const res = await pool.query(`SELECT count(*)::int AS n FROM projects WHERE name = $1`, [NAME]);
  assert.equal(res.rows[0].n, 2, "the global unique constraint on name should be gone");
});

test("getProject only sees projects in the requested org", async () => {
  await getOrCreateProject(NAME, "/tmp/orgs-fixture");
  await getOrCreateProject(NAME, "/tmp/orgs-fixture-other", otherOrgId);

  assert.equal((await getProject(NAME)).root_path, "/tmp/orgs-fixture");
  assert.equal((await getProject(NAME, otherOrgId)).root_path, "/tmp/orgs-fixture-other");
});

test("listProjects is scoped to one org", async () => {
  await getOrCreateProject(NAME, "/tmp/orgs-fixture");
  await getOrCreateProject(NAME, "/tmp/orgs-fixture-other", otherOrgId);

  const mine = await listProjects();
  const theirs = await listProjects(otherOrgId);
  assert.ok(mine.every((p) => p.org_id === defaultOrgId));
  assert.deepEqual(theirs.map((p) => p.name), [NAME]);
});

test("upserting in one org does not touch the same-named project in another", async () => {
  await getOrCreateProject(NAME, "/tmp/orgs-fixture", defaultOrgId);
  await getOrCreateProject(NAME, "/tmp/orgs-fixture-other", otherOrgId);
  await getOrCreateProject(NAME, "/tmp/orgs-fixture-moved", defaultOrgId);

  assert.equal((await getProject(NAME)).root_path, "/tmp/orgs-fixture-moved");
  assert.equal((await getProject(NAME, otherOrgId)).root_path, "/tmp/orgs-fixture-other");
});

test("deleteProject only deletes within its own org", async () => {
  await getOrCreateProject(NAME, "/tmp/orgs-fixture");
  await getOrCreateProject(NAME, "/tmp/orgs-fixture-other", otherOrgId);

  const deleted = await deleteProject(NAME);
  assert.equal(deleted.org_id, defaultOrgId);
  assert.equal(await getProject(NAME), null);
  assert.ok(await getProject(NAME, otherOrgId), "the other org's project must survive");
});

test("embedding_usage rows carry an org for attribution after project deletion", async () => {
  const res = await pool.query(`SELECT count(*)::int AS n FROM embedding_usage WHERE org_id IS NULL`);
  assert.equal(res.rows[0].n, 0, "orphaned usage rows would drop out of cost totals");
});
