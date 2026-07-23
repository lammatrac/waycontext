import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb, getProject, deleteProject } from "../src/db.js";
import { createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject } from "./helpers/testProject.js";

const PROJECT = "delete_project_fixture";
const MISSING_PROJECT = "delete_project_fixture_missing";

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(MISSING_PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(MISSING_PROJECT);
  await pool.end();
});

test("deleteProject removes the project and cascades to files/symbols/edges", async () => {
  const project = await createTestProject(PROJECT);
  const fileId = await insertTestFile(project.id, "src/example.js");
  const symbolId = await insertTestSymbol(project.id, fileId, { name: "exampleFn" });
  await pool.query(
    `INSERT INTO edges (project_id, src, dst, relation, file_id, line)
     VALUES ($1, $2, NULL, 'CALLS', $3, 1)`,
    [project.id, symbolId, fileId]
  );

  const deleted = await deleteProject(PROJECT);
  assert.equal(deleted.id, project.id);
  assert.equal(deleted.name, PROJECT);

  assert.equal(await getProject(PROJECT), null);

  const fileCount = await pool.query(`SELECT count(*)::int AS n FROM files WHERE project_id = $1`, [project.id]);
  assert.equal(fileCount.rows[0].n, 0);

  const symbolCount = await pool.query(`SELECT count(*)::int AS n FROM symbols WHERE project_id = $1`, [project.id]);
  assert.equal(symbolCount.rows[0].n, 0);

  const edgeCount = await pool.query(`SELECT count(*)::int AS n FROM edges WHERE project_id = $1`, [project.id]);
  assert.equal(edgeCount.rows[0].n, 0);
});

test("deleteProject returns null for a project that does not exist", async () => {
  const result = await deleteProject(MISSING_PROJECT);
  assert.equal(result, null);
});
