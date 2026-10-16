import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

/**
 * Re-indexing an already-indexed project needs only its name: the root path
 * recorded by the first run is reused when `path` is omitted.
 */

const PROJECT = "wc_stored_root_test";
const UNKNOWN = "wc_stored_root_unknown_test";
let dir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(UNKNOWN);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-stored-root-"));
  fs.writeFileSync(path.join(dir, "a.js"), "export function alpha() { return 1; }\n");
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await cleanupTestProject(UNKNOWN);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("omitting path re-indexes from the root stored by the previous run", async () => {
  await indexProject(PROJECT, dir);
  fs.writeFileSync(path.join(dir, "b.js"), "export function beta() { return 2; }\n");

  const stats = await indexProject(PROJECT, undefined);

  assert.equal(stats.changed, 1, "only the new file should be re-indexed");
  assert.equal((await getProject(PROJECT)).root_path, path.resolve(dir));
});

test("omitting path for a project that was never indexed asks for one by name", async () => {
  await assert.rejects(indexProject(UNKNOWN, undefined), /not indexed yet.*`path`/);
  assert.equal(await getProject(UNKNOWN), null, "no project row should be created");
});
