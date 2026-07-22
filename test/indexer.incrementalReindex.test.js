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

test("a failed file does not advance last_indexed_sha, so it's retried next run", async () => {
  const FAIL_PROJECT = "incremental_reindex_failure_fixture";
  const dir = createGitRepo();
  const noPermPath = path.join(dir, "noperm.js");
  try {
    await cleanupTestProject(FAIL_PROJECT);

    writeRepoFile(dir, "ok.js", "function ok() { return 1; }");
    const c1 = commitAll(dir, "first");

    let stats = await indexProject(FAIL_PROJECT, dir);
    assert.equal(stats.mode, "full");
    assert.equal(stats.failed, 0);

    let row = await pool.query(
      `SELECT last_indexed_sha, indexed_at FROM projects WHERE name = $1`,
      [FAIL_PROJECT]
    );
    assert.equal(row.rows[0].last_indexed_sha, c1);
    const indexedAtAfterFirstRun = row.rows[0].indexed_at;

    // Second commit moves HEAD forward. noperm.js is a real, untracked file
    // that indexProject will discover via the git diff (as an untracked
    // path) but cannot read: chmod 000 makes fs.readFileSync throw EACCES,
    // which is exactly the "read error" path in indexProject's per-file loop
    // that increments `failed`. This is a genuine, unmodified-production-code
    // reproduction of a transient read failure.
    writeRepoFile(dir, "new.js", "function n() { return 2; }");
    const c2 = commitAll(dir, "second");
    assert.notEqual(c2, c1);
    writeRepoFile(dir, "noperm.js", "function bad() { return 0; }");
    fs.chmodSync(noPermPath, 0o000);

    stats = await indexProject(FAIL_PROJECT, dir);
    assert.equal(stats.mode, "diff");
    assert.equal(stats.failed, 1);
    assert.equal(stats.changed, 1); // new.js only; noperm.js failed to read

    row = await pool.query(
      `SELECT last_indexed_sha, indexed_at FROM projects WHERE name = $1`,
      [FAIL_PROJECT]
    );
    // sha must NOT advance to c2, even though a real commit exists at HEAD
    assert.equal(row.rows[0].last_indexed_sha, c1);
    assert.notEqual(row.rows[0].last_indexed_sha, c2);
    // indexed_at still updates: a run did happen, even if partially failed
    assert.ok(new Date(row.rows[0].indexed_at) > new Date(indexedAtAfterFirstRun));

    // Fix the file and re-run: since last_indexed_sha is still c1, the diff
    // is recomputed from the same base, so noperm.js is "changed" again and
    // gets retried (while new.js hash-matches and is skipped cheaply).
    fs.chmodSync(noPermPath, 0o644);

    stats = await indexProject(FAIL_PROJECT, dir);
    assert.equal(stats.mode, "diff");
    assert.equal(stats.failed, 0);
    assert.equal(stats.changed, 1); // noperm.js now indexed successfully
    assert.equal(stats.skipped, 1); // new.js hash-matches from the prior run

    const files = await pool.query(
      `SELECT path FROM files f JOIN projects p ON p.id = f.project_id
       WHERE p.name = $1 ORDER BY path`,
      [FAIL_PROJECT]
    );
    assert.deepEqual(files.rows.map((r) => r.path), ["new.js", "noperm.js", "ok.js"]);

    row = await pool.query(
      `SELECT last_indexed_sha FROM projects WHERE name = $1`,
      [FAIL_PROJECT]
    );
    assert.equal(row.rows[0].last_indexed_sha, c2);
  } finally {
    try { fs.chmodSync(noPermPath, 0o644); } catch { /* best-effort, ignore ENOENT */ }
    await cleanupTestProject(FAIL_PROJECT);
    cleanupGitRepo(dir);
  }
});

test("a failed file on the very first (full) scan leaves last_indexed_sha unset", async () => {
  const FAIL_PROJECT = "incremental_reindex_failure_first_run_fixture";
  const dir = createGitRepo();
  const noPermPath = path.join(dir, "noperm.js");
  try {
    await cleanupTestProject(FAIL_PROJECT);

    // Commit so HEAD has a real, non-null sha: this makes the assertion below
    // meaningful (it distinguishes "sha correctly left unset" from "sha
    // happened to be null because there was nothing to advance to anyway").
    writeRepoFile(dir, "ok.js", "function ok() { return 1; }");
    commitAll(dir, "first");
    // noperm.js is added after the commit (untracked, unreadable) so the
    // full scan (fast-glob) still discovers it on disk without needing git
    // to be able to read its contents.
    writeRepoFile(dir, "noperm.js", "function bad() { return 0; }");
    fs.chmodSync(noPermPath, 0o000);

    const stats = await indexProject(FAIL_PROJECT, dir);
    assert.equal(stats.mode, "full"); // no last_indexed_sha yet -> full scan
    assert.equal(stats.failed, 1);
    assert.equal(stats.changed, 1);

    const row = await pool.query(
      `SELECT last_indexed_sha FROM projects WHERE name = $1`,
      [FAIL_PROJECT]
    );
    assert.equal(row.rows[0].last_indexed_sha, null);
  } finally {
    try { fs.chmodSync(noPermPath, 0o644); } catch { /* best-effort, ignore ENOENT */ }
    await cleanupTestProject(FAIL_PROJECT);
    cleanupGitRepo(dir);
  }
});
