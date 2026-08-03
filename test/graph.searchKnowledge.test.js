import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { searchKnowledge, searchCode } from "../src/graph.js";
import { cleanupTestProject } from "./helpers/testProject.js";

const PROJECT = "search_knowledge_fixture";
let root;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-know-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src/graph.js"),
    "export function fuseRankedLists() { /* reciprocal rank fusion */ }\n"
  );
  fs.writeFileSync(
    path.join(root, "docs/why-rrf.md"),
    "# Why reciprocal rank fusion\nWe fuse full-text and vector lists because neither ranking alone is reliable.\n"
  );
  await indexProject(PROJECT, root);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (root) fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

test("prose and code both come back, tagged by type", async () => {
  const hits = await searchKnowledge(PROJECT, "reciprocal rank fusion", 10);
  const types = new Set(hits.map((h) => h.type));
  assert.ok(types.has("doc"), "a doc chunk was returned");
  assert.ok(types.has("code"), "a symbol was returned");

  const doc = hits.find((h) => h.type === "doc");
  assert.equal(doc.path, "docs/why-rrf.md");
  assert.ok(doc.heading_path.includes("Why reciprocal rank fusion"));
  assert.ok(doc.snippet.length > 0);
  assert.ok(Array.isArray(doc.matched_via) && doc.matched_via.length > 0);
});

test("code hits keep the fields search_code returns", async () => {
  const hits = await searchKnowledge(PROJECT, "reciprocal rank fusion", 10);
  const code = hits.find((h) => h.type === "code");
  assert.equal(code.path, "src/graph.js");
  assert.equal(code.title, "fuseRankedLists");
  assert.ok(Number.isInteger(code.start_line));
});

test("results are ordered by fused score", async () => {
  const scores = (await searchKnowledge(PROJECT, "reciprocal rank fusion", 10)).map((h) => h.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("limit is honoured", async () => {
  assert.ok((await searchKnowledge(PROJECT, "fusion", 1)).length <= 1);
});

test("search_code still returns only code", async () => {
  const hits = await searchCode(PROJECT, "reciprocal rank fusion", 10);
  assert.ok(hits.length > 0);
  assert.ok(
    hits.every((h) => h.path.endsWith(".js")),
    "no doc chunks leaked into search_code"
  );
});

test("an unknown project fails the same way search_code does", async () => {
  await assert.rejects(() => searchKnowledge("no_such_project_here", "x", 5), /not found/);
});
