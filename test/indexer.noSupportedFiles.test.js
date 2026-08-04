import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { EXT_LANG } from "../src/parser.js";

/**
 * Pointing WayContext at a language it doesn't parse used to log
 * `Found 0 source files` and report success. Searches then returned nothing, and
 * the actual cause -- wrong path, or an unsupported stack -- surfaced much later.
 */

const PROJECT = "wc_no_supported_files_test";
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

/** Capture the log lines indexProject emits. */
async function indexCapturing(project, root) {
  const lines = [];
  const stats = await indexProject(project, root, (m) => lines.push(String(m)));
  return { stats, log: lines.join("\n") };
}

test("a repo of unsupported languages says so instead of reporting a silent success", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rust-"));
  fs.writeFileSync(path.join(dir, "main.rs"), "fn main() { println!(\"hi\"); }");
  fs.writeFileSync(path.join(dir, "lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { a + b }");
  fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"demo\"\n");

  const { stats, log } = await indexCapturing(PROJECT, dir);

  assert.equal(stats.changed, 0, "precondition: nothing was indexable");
  assert.match(log, /No supported source files found/);
  // The message has to say what IS supported, or it just restates the symptom.
  assert.match(log, /\.js/);
  assert.match(log, /\.go/);
  assert.match(log, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the supported-extension list is derived from the parser, not hardcoded", async () => {
  // Guards the reason it's built from EXT_LANG: adding a grammar must not leave
  // this message advertising the old set.
  const { log } = await indexCapturing(PROJECT, dir);
  for (const ext of Object.keys(EXT_LANG)) {
    assert.ok(log.includes(ext), `message should list ${ext}`);
  }
});

test("a repo with supported files does not emit the warning", async () => {
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), "wc-js-"));
  try {
    fs.writeFileSync(path.join(ok, "a.js"), "function a() { return 1; }");
    const { stats, log } = await indexCapturing(`${PROJECT}_ok`, ok);
    assert.equal(stats.changed, 1);
    assert.doesNotMatch(log, /No supported source files found/);
  } finally {
    fs.rmSync(ok, { recursive: true, force: true });
    await cleanupTestProject(`${PROJECT}_ok`);
  }
});
