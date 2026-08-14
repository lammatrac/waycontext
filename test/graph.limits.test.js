import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { initDb, pool } from "../src/db.js";
import { getSymbol, getCallers, getFileOutline } from "../src/graph.js";
import {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} from "./helpers/testProject.js";

/**
 * These endpoints used to have no row cap at all: get_callers on a common
 * name in a large indexed project can have tens of thousands of inbound
 * edges, and get_symbol returned a full source body for every one of up to
 * 5 same-named candidates. Both blew up token usage for callers that just
 * wanted a bounded answer.
 */

const PROJECT = "wc_limits_test";
let projectId;
let fileId;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  projectId = project.id;
  fileId = await insertTestFile(projectId, "src/limits.js");
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

test("get_symbol keeps the full body only on the best-ranked candidate", async () => {
  const targetId = await insertTestSymbol(projectId, fileId, {
    name: "Widget::run", kind: "method", body: "function run() { return 1; }",
  });
  await insertTestSymbol(projectId, fileId, {
    name: "Gadget::run", kind: "method", body: "function run() { return 2; }",
  });

  const rows = await getSymbol(PROJECT, "run");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].body, "best match should keep its source body");
  assert.equal(rows[1].body, undefined, "secondary matches should not carry a body");

  // The stub can still be turned into a full read via the qualified name.
  const [exact] = await getSymbol(PROJECT, rows[1].name);
  assert.ok(exact.body);
  void targetId;
});

test("get_symbol respects an explicit limit on candidate count", async () => {
  for (let i = 0; i < 4; i++) {
    await insertTestSymbol(projectId, fileId, { name: `Dup${i}::shared`, body: "x" });
  }
  const rows = await getSymbol(PROJECT, "shared", 2);
  assert.equal(rows.length, 2);
});

test("get_callers caps at the default limit but a real symbol can still exceed it", async () => {
  const targetId = await insertTestSymbol(projectId, fileId, { name: "hotSymbol" });
  for (let i = 0; i < 15; i++) {
    const callerId = await insertTestSymbol(projectId, fileId, { name: `caller${i}` });
    await pool.query(
      `INSERT INTO edges (project_id, src, dst, relation, file_id, line)
       VALUES ($1, $2, $3, 'CALLS', $4, 1)`,
      [projectId, callerId, targetId, fileId]
    );
  }

  const capped = await getCallers(PROJECT, "hotSymbol");
  assert.equal(capped.length, 10, "default limit should cap the result");

  const raised = await getCallers(PROJECT, "hotSymbol", 15);
  assert.equal(raised.length, 15, "an explicit limit should be honoured");
});

test("get_file_outline caps at the default limit", async () => {
  const bigFile = await insertTestFile(projectId, "src/big.js");
  for (let i = 0; i < 12; i++) {
    await insertTestSymbol(projectId, bigFile, { name: `sym${i}` });
  }
  const outline = await getFileOutline(PROJECT, "src/big.js");
  assert.equal(outline.length, 10);

  const raised = await getFileOutline(PROJECT, "src/big.js", 20);
  assert.equal(raised.length, 12);
});
