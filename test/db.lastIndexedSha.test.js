import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, getOrCreateProject } from "../src/db.js";
import { cleanupTestProject } from "./helpers/testProject.js";

const PROJECT = "last_indexed_sha_fixture";

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("last_indexed_sha column exists and defaults to null on a new project", async () => {
  const project = await getOrCreateProject(PROJECT, "/tmp/last_indexed_sha_fixture");
  assert.equal(project.last_indexed_sha, null);
});

test("last_indexed_sha survives a getOrCreateProject upsert that changes root_path", async () => {
  const project = await getOrCreateProject(PROJECT, "/tmp/last_indexed_sha_fixture");
  await pool.query(
    `UPDATE projects SET last_indexed_sha = $1 WHERE id = $2`,
    ["deadbeef", project.id]
  );
  const reupserted = await getOrCreateProject(PROJECT, "/tmp/last_indexed_sha_fixture_moved");
  assert.equal(reupserted.last_indexed_sha, "deadbeef");
  assert.equal(reupserted.root_path, "/tmp/last_indexed_sha_fixture_moved");
});
