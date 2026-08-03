import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { getHistory, whoOwns, resolveTarget } from "../src/knowledge/history.js";
import { getProject } from "../src/db.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { createGitRepo, git, writeRepoFile, cleanupGitRepo } from "./helpers/gitFixture.js";

const PROJECT = "history_queries_fixture";
let repoDir;

const AUTH_BODY = `function verifyToken(token) {
  const payload = decode(token);
  if (payload.exp < Date.now() / 1000) throw new Error('expired');
  return payload;
}`;

/**
 * Commit as a given identity at a given date. Ownership decay is the point of
 * who_owns, so the dates have to be controllable rather than "now".
 */
function commitAs(dir, { name, email, message, daysAgo = 0 }) {
  const when = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c", `user.name=${name}`, "-c", `user.email=${email}`,
    "commit", "-q", "-m", message, `--date=${when}`,
  ]);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repoDir = createGitRepo();
  process.env.GIT_COMMITTER_DATE = new Date().toISOString();

  writeRepoFile(repoDir, "auth.js", AUTH_BODY);
  commitAs(repoDir, {
    name: "Old Timer", email: "old@example.com",
    message: "feat: add token verification", daysAgo: 900,
  });

  // Old Timer wrote most of it, a long time ago...
  for (let i = 0; i < 4; i++) {
    writeRepoFile(repoDir, "auth.js", `${AUTH_BODY}\n// revision ${i}`);
    commitAs(repoDir, {
      name: "Old Timer", email: "old@example.com",
      message: `refactor: tidy verification pass ${i}`, daysAgo: 800 - i * 10,
    });
  }

  // ...but Recent Dev is the one who has touched it lately.
  writeRepoFile(repoDir, "auth.js", `${AUTH_BODY}\n// leeway added`);
  commitAs(repoDir, {
    name: "Recent Dev", email: "recent@example.com",
    message: "fix: JWT timeout rejects valid tokens\n\nFixes #1532", daysAgo: 5,
  });

  writeRepoFile(repoDir, "unrelated.js", "function unrelated() { return 'x'.repeat(50); }");
  commitAs(repoDir, {
    name: "Third Party", email: "third@example.com",
    message: "chore: add an unrelated helper", daysAgo: 2,
  });

  await indexProject(PROJECT, repoDir);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repoDir) cleanupGitRepo(repoDir);
  await pool.end();
});

// --- target resolution -----------------------------------------------------

test("a target resolves as a file, a symbol, a directory, or the whole project", async () => {
  const project = await getProject(PROJECT);
  assert.deepEqual(await resolveTarget(project, "auth.js"), {
    kind: "file", value: "auth.js", paths: ["auth.js"],
  });
  assert.deepEqual(await resolveTarget(project, "verifyToken"), {
    kind: "symbol", value: "verifyToken", paths: ["auth.js"],
  });
  assert.deepEqual(await resolveTarget(project, undefined), {
    kind: "project", value: null, paths: null,
  });
});

test("an unresolvable target says so instead of silently returning everything", async () => {
  const project = await getProject(PROJECT);
  await assert.rejects(
    () => resolveTarget(project, "no/such/thing.js"),
    /No file, symbol or directory named/
  );
});

// --- get_history -----------------------------------------------------------

test("get_history returns the commits for a file, newest first", async () => {
  const result = await getHistory(PROJECT, "auth.js", 10);
  assert.equal(result.target.kind, "file");
  assert.equal(result.summary.total_commits, 6);
  assert.equal(result.summary.contributors, 2);
  assert.equal(result.commits[0].subject, "fix: JWT timeout rejects valid tokens");

  const dates = result.commits.map((c) => new Date(c.authored_at).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), "must be newest first");

  // The unrelated file's commit must not leak into a scoped query.
  assert.ok(!result.commits.some((c) => c.subject.includes("unrelated")));
});

test("get_history answers the headline question: which ticket, how long ago", async () => {
  const result = await getHistory(PROJECT, "verifyToken", 10);
  assert.equal(result.target.kind, "symbol");
  const fix = result.commits.find((c) => c.is_fix);
  assert.ok(fix, "the JWT timeout fix should be flagged as a fix");
  assert.deepEqual(fix.issues, [
    { tracker: "github", key: "1532", url: null, relation: "FIXES", known: false },
  ]);
});

test("get_history without a target reports recent project-wide activity", async () => {
  const result = await getHistory(PROJECT, undefined, 10);
  assert.equal(result.target.kind, "project");
  assert.equal(result.summary.total_commits, 7);
  assert.ok(result.commits.every((c) => c.paths.length > 0), "each commit should name what it touched");
});

test("get_history follows a symbol across a file move", async () => {
  const moved = `${PROJECT}_moved`;
  await pool.query(`DELETE FROM projects WHERE name = $1`, [moved]);
  try {
    await indexProject(moved, repoDir);
    const beforeMove = await getHistory(moved, "verifyToken", 20);
    assert.equal(beforeMove.target.paths.length, 1);

    const current = fs.readFileSync(path.join(repoDir, "auth.js"), "utf8");
    fs.rmSync(path.join(repoDir, "auth.js"));
    writeRepoFile(repoDir, "lib/auth.js", current);
    commitAs(repoDir, { name: "Recent Dev", email: "recent@example.com", message: "refactor: move auth into lib" });
    await indexProject(moved, repoDir);

    const afterMove = await getHistory(moved, "verifyToken", 20);
    assert.deepEqual(afterMove.target.paths.sort(), ["auth.js", "lib/auth.js"]);
    // The point of the identity plane: the history from before the move is
    // still attached to the symbol, not stranded on a path nobody will ask for.
    assert.ok(
      afterMove.commits.some((c) => c.subject === "feat: add token verification"),
      "history from before the move must still be reachable"
    );
  } finally {
    await pool.query(`DELETE FROM projects WHERE name = $1`, [moved]);
    // Put the fixture repo back for any later test.
    const current = fs.readFileSync(path.join(repoDir, "lib/auth.js"), "utf8");
    fs.rmSync(path.join(repoDir, "lib"), { recursive: true, force: true });
    writeRepoFile(repoDir, "auth.js", current);
    commitAs(repoDir, { name: "Recent Dev", email: "recent@example.com", message: "refactor: move auth back" });
  }
});

// --- who_owns --------------------------------------------------------------

test("who_owns ranks by recent work, not by total lines written", async () => {
  const result = await whoOwns(PROJECT, "auth.js", 10);
  assert.equal(result.owners.length, 2);

  const [top, second] = result.owners;
  assert.equal(top.email, "recent@example.com");
  assert.equal(second.email, "old@example.com");
  // Old Timer has five of the six commits; recency is what flips the order.
  assert.ok(second.commits > top.commits, "the runner-up should have more raw commits");
  assert.ok(top.score > second.score, "but a lower score");
  assert.ok(top.share > 0.5);
});

test("who_owns reports what the top contributor actually did", async () => {
  const result = await whoOwns(PROJECT, "verifyToken", 5);
  const [top] = result.owners;
  assert.equal(top.name, "Recent Dev");
  assert.equal(top.last_change, "fix: JWT timeout rejects valid tokens");
  assert.equal(top.fix_commits, 1);
  assert.ok(top.last_touch > top.first_touch || +top.last_touch === +top.first_touch);
});

test("who_owns scoped to a file excludes people who never touched it", async () => {
  const result = await whoOwns(PROJECT, "auth.js", 10);
  assert.ok(!result.owners.some((o) => o.email === "third@example.com"));

  const projectWide = await whoOwns(PROJECT, undefined, 10);
  assert.ok(projectWide.owners.some((o) => o.email === "third@example.com"));
});

test("half-life is reported so the ranking can be interpreted", async () => {
  const result = await whoOwns(PROJECT, "auth.js", 10);
  assert.equal(result.half_life_days, 180);
});
