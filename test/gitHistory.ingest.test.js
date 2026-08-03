import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { createGitRepo, git, writeRepoFile, commitAll, cleanupGitRepo } from "./helpers/gitFixture.js";

const PROJECT = "git_history_fixture";
let repoDir;
let projectId;

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

/**
 * Commit as a specific identity at an explicit time.
 *
 * The date is not decoration: commits made in the same second sort
 * arbitrarily, and any assertion about "the first commit" is then a coin flip.
 */
function commitAs(dir, { name, email, message, daysAgo = 0 }) {
  const when = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c", `user.name=${name}`, "-c", `user.email=${email}`,
    "commit", "-q", "-m", message, `--date=${when}`,
  ]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

test("indexing a git repo ingests its history alongside the code", async () => {
  writeRepoFile(repoDir, "alpha.js", "function alpha() { return 'a'.repeat(10); }");
  commitAs(repoDir, {
    name: "Ann Example", email: "ann@example.com",
    message: "feat: add alpha handler (#12)", daysAgo: 2,
  });

  writeRepoFile(repoDir, "beta.js", "function beta() { return 'b'.repeat(10); }");
  commitAs(repoDir, {
    name: "Bo Example", email: "bo@example.com",
    message: "fix: correct beta rounding\n\nFixes #34\n\nCo-authored-by: Ann Example <ann@example.com>",
    daysAgo: 1,
  });

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.failed, 0);
  assert.equal(stats.history.commits, 2);
  assert.equal(stats.history.mode, "full");

  const [project] = await q(`SELECT id, last_history_sha FROM projects WHERE name = $1`, [PROJECT]);
  projectId = project.id;
  assert.ok(project.last_history_sha, "last_history_sha should advance on a clean run");

  const commits = await q(
    `SELECT subject, is_fix, author_email, files_changed FROM commits
      WHERE project_id = $1 ORDER BY authored_at`,
    [projectId]
  );
  assert.equal(commits.length, 2);
  assert.equal(commits[0].author_email, "ann@example.com");
  assert.equal(commits[0].is_fix, false);
  assert.equal(commits[1].is_fix, true);
  assert.equal(commits[1].files_changed, 1);
});

test("per-file churn is recorded against project-relative paths", async () => {
  const churn = await q(
    `SELECT cf.path, cf.additions FROM commit_files cf WHERE cf.project_id = $1 ORDER BY cf.path`,
    [projectId]
  );
  assert.deepEqual(churn.map((r) => r.path), ["alpha.js", "beta.js"]);
  assert.ok(churn.every((r) => r.additions > 0));

  // The churn table must line up with `files`, or ownership joins silently
  // return nothing.
  const orphans = await q(
    `SELECT cf.path FROM commit_files cf
      WHERE cf.project_id = $1
        AND NOT EXISTS (SELECT 1 FROM files f WHERE f.project_id = $1 AND f.path = cf.path)`,
    [projectId]
  );
  assert.deepEqual(orphans, []);
});

test("referenced issues become entities even with no tracker configured", async () => {
  // The stub-issue trick: this is what makes issue<->code linkage work on a
  // laptop with zero integrations, which is the whole Phase 1 demo.
  const issues = await q(
    `SELECT i.tracker, i.external_key, e.source, el.relation
       FROM issues i
       JOIN entities e ON e.id = i.entity_id
       JOIN entity_links el ON el.dst_id = i.entity_id
      WHERE i.project_id = $1 ORDER BY i.external_key`,
    [projectId]
  );
  assert.deepEqual(
    issues.map((r) => [r.tracker, r.external_key, r.source, r.relation]),
    [
      ["github", "12", "inferred", "REFERENCES"],
      ["github", "34", "inferred", "FIXES"],
    ]
  );
});

test("authors and co-authors are linked to the commits they worked on", async () => {
  const people = await q(
    `SELECT p.canonical_email, p.display_name, p.commit_count
       FROM people p WHERE p.project_id = $1 ORDER BY p.canonical_email`,
    [projectId]
  );
  assert.deepEqual(people.map((r) => r.canonical_email), ["ann@example.com", "bo@example.com"]);
  // Ann authored one commit and co-authored another; commit_count counts
  // authorship only.
  assert.equal(people.find((r) => r.canonical_email === "ann@example.com").commit_count, 1);

  const coAuthored = await q(
    `SELECT count(*)::int AS n FROM entity_links el
       JOIN entities src ON src.id = el.src_id
      WHERE src.project_id = $1 AND el.relation = 'CO_AUTHORED_BY'`,
    [projectId]
  );
  assert.equal(coAuthored[0].n, 1);
});

test("a second run reads only the new commits", async () => {
  writeRepoFile(repoDir, "gamma.js", "function gamma() { return 'g'.repeat(10); }");
  commitAs(repoDir, { name: "Ann Example", email: "ann@example.com", message: "feat: add gamma" });

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.history.mode, "incremental");
  assert.equal(stats.history.commits, 1, "should read the one new commit, not re-read all three");

  const [{ n }] = await q(`SELECT count(*)::int AS n FROM commits WHERE project_id = $1`, [projectId]);
  assert.equal(n, 3);
});

test("a run with nothing new to read does no work and stays consistent", async () => {
  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.history.commits, 0);
  assert.equal(stats.history.upToDate, true);

  const [{ n }] = await q(`SELECT count(*)::int AS n FROM commits WHERE project_id = $1`, [projectId]);
  assert.equal(n, 3);
});

test("re-ingesting the same range converges instead of duplicating rows", async () => {
  // Force a full re-read by clearing the watermark, the way a rewritten
  // history (rebase, squash-merge) would.
  await pool.query(`UPDATE projects SET last_history_sha = NULL WHERE id = $1`, [projectId]);
  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.history.mode, "full");
  assert.equal(stats.history.commits, 3);

  const [counts] = await q(
    `SELECT (SELECT count(*) FROM commits WHERE project_id = $1)::int AS commits,
            (SELECT count(*) FROM commit_files WHERE project_id = $1)::int AS churn,
            (SELECT count(*) FROM people WHERE project_id = $1)::int AS people,
            (SELECT count(*) FROM entity_links el JOIN entities e ON e.id = el.src_id
              WHERE e.project_id = $1)::int AS links`,
    [projectId]
  );
  // 3 AUTHORED_BY + 1 CO_AUTHORED_BY + REFERENCES #12 + FIXES #34.
  assert.deepEqual(counts, { commits: 3, churn: 3, people: 2, links: 6 });
});

test("a directory that is not a git repo indexes fine and reports no history", async () => {
  const plainProject = `${PROJECT}_plain`;
  const dir = createGitRepo();
  await pool.query(`DELETE FROM projects WHERE name = $1`, [plainProject]);
  try {
    // Strip the repo back to a plain directory with source in it.
    writeRepoFile(dir, "solo.js", "function solo() { return 1; }");
    const { rmSync } = await import("node:fs");
    rmSync(`${dir}/.git`, { recursive: true, force: true });

    const stats = await indexProject(plainProject, dir);
    assert.equal(stats.failed, 0);
    assert.equal(stats.changed, 1);
    assert.equal(stats.history.commits, 0);
    assert.equal(stats.history.mode, "skipped");
  } finally {
    await pool.query(`DELETE FROM projects WHERE name = $1`, [plainProject]);
    cleanupGitRepo(dir);
  }
});
