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

const PROJECT = "concurrent_reindex_fixture";
const FILE_COUNT = 40;
let repoDir;

function writeCrossReferencingFiles(dir) {
  for (let i = 0; i < FILE_COUNT; i++) {
    let body = `function f${i}() {\n`;
    for (let j = 0; j < FILE_COUNT; j++) {
      if (j !== i) body += `  f${j}();\n`;
    }
    body += `}\n`;
    writeRepoFile(dir, `f${i}.js`, body);
  }
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repoDir) cleanupGitRepo(repoDir);
  await pool.end();
});

test("two overlapping indexProject runs on the same project don't deadlock or corrupt data", async () => {
  repoDir = createGitRepo();
  writeCrossReferencingFiles(repoDir);
  commitAll(repoDir, "first");
  await indexProject(PROJECT, repoDir);

  // Touch every file so a second run treats them all as changed again, then
  // fire two indexProject calls concurrently against the same project/root
  // - what a commit-hook reindex racing a pull-hook reindex from another
  // session looks like. Without serialization this reliably reproduces a
  // deadlock (40P01) or a dst/src foreign-key violation (23503), because
  // each run's per-file DELETE+INSERT of symbols reassigns fresh ids while
  // the other run's edge-resolution still references the old ones.
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.appendFileSync(path.join(repoDir, `f${i}.js`), `// touch\n`);
  }
  commitAll(repoDir, "touch all");

  const results = await Promise.allSettled([
    indexProject(PROJECT, repoDir),
    indexProject(PROJECT, repoDir),
  ]);

  for (const r of results) {
    assert.equal(r.status, "fulfilled", r.reason && r.reason.message);
  }

  const totalChanged = results.reduce((sum, r) => sum + r.value.changed, 0);
  assert.equal(totalChanged, FILE_COUNT); // one run does the work, the other sees nothing left

  const edgeCounts = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE dst IS NULL)::int AS unresolved
     FROM edges e JOIN projects p ON p.id = e.project_id WHERE p.name = $1`,
    [PROJECT]
  );
  assert.equal(edgeCounts.rows[0].unresolved, 0); // every call is resolvable within this fixture
});
