import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

/**
 * A 19-minute index printed "Found N source files" and then nothing that said
 * where the time went. Each run now reports how long every phase took.
 */

const PROJECT = "wc_phase_timings_test";
let dir;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("an index run reports per-phase durations in its stats and its log", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-timings-"));
  fs.writeFileSync(path.join(dir, "a.js"), "function a() { return 1; }");
  const lines = [];
  const stats = await indexProject(PROJECT, dir, (m) => lines.push(String(m)));

  for (const phase of ["scan", "files", "edges", "embeddings", "derive"]) {
    assert.equal(typeof stats.timings[phase], "number", `timings.${phase}`);
    assert.ok(stats.timings[phase] >= 0);
  }
  assert.match(lines.join("\n"), /Timings: scan \d+(\.\d+)?s, files \d+(\.\d+)?s, edges/);
});
