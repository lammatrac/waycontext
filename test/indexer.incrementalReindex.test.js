import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import {
  createGitRepo, writeRepoFile, commitAll, cleanupGitRepo,
} from "./helpers/gitFixture.js";

const PROJECT = "incremental_reindex_fixture";
let repoDir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repoDir) cleanupGitRepo(repoDir);
  await pool.end();
});

test("first index of a git repo does a full scan and records last_indexed_sha", async () => {
  repoDir = createGitRepo();
  writeRepoFile(repoDir, "a.js", "function a() { return 1; }");
  writeRepoFile(repoDir, "b.js", "function b() { return 2; }");
  commitAll(repoDir, "first");

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.mode, "full");
  assert.equal(stats.changed, 2);

  const res = await pool.query(
    `SELECT last_indexed_sha FROM projects WHERE name = $1`, [PROJECT]
  );
  assert.ok(res.rows[0].last_indexed_sha);
});

test("a no-op re-run uses diff mode and touches nothing", async () => {
  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.mode, "diff");
  assert.equal(stats.changed, 0);
  assert.equal(stats.total, 0); // diff-mode total = candidates considered, not project size
});

test("a re-run after an edit + delete only touches the diffed files", async () => {
  writeRepoFile(repoDir, "a.js", "function a() { return 999; }"); // modified
  writeRepoFile(repoDir, "c.js", "function c() { return 3; }"); // new, untracked
  fs.unlinkSync(path.join(repoDir, "b.js")); // deleted

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.mode, "diff");
  assert.equal(stats.changed, 2); // a.js + c.js
  assert.equal(stats.removed, 1); // b.js

  const files = await pool.query(
    `SELECT path FROM files f JOIN projects p ON p.id = f.project_id
     WHERE p.name = $1 ORDER BY path`,
    [PROJECT]
  );
  assert.deepEqual(files.rows.map((r) => r.path), ["a.js", "c.js"]);
});
