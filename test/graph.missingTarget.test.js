import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { initDb, pool } from "../src/db.js";
import {
  getSymbol, getCallers, getCallees, getSubgraph, getFileOutline, findRelated,
} from "../src/graph.js";
import { getRules } from "../src/knowledge/rules.js";
import {
  createTestProject, insertTestFile, insertTestSymbol, cleanupTestProject,
} from "./helpers/testProject.js";

/**
 * A name that doesn't resolve must say so, on every query that takes one.
 *
 * These used to split three ways: get_symbol/get_callers/get_callees/
 * get_file_outline/find_related returned `[]`, get_graph threw a terse
 * `Symbol "x" not found`, and the history family threw with guidance. `[]` is the
 * dangerous one -- for get_callers it reads as "nothing calls this, safe to
 * change" rather than "you typed the name wrong".
 */

const PROJECT = "wc_missing_target_test";
let projectId;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  const project = await createTestProject(PROJECT);
  projectId = project.id;
  const fileId = await insertTestFile(projectId, "src/real.js");
  await insertTestSymbol(projectId, fileId, { name: "realFunction" });
  await insertTestSymbol(projectId, fileId, { name: "Widget::render", kind: "method" });
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

const MISSING = /No symbol named "ZZZnope"/;

test("get_symbol rejects a name that doesn't exist", async () => {
  await assert.rejects(() => getSymbol(PROJECT, "ZZZnope"), MISSING);
});

test("get_callers rejects a name that doesn't exist", async () => {
  // The important one: [] here is indistinguishable from "has no callers".
  await assert.rejects(() => getCallers(PROJECT, "ZZZnope"), MISSING);
});

test("get_callees rejects a name that doesn't exist", async () => {
  await assert.rejects(() => getCallees(PROJECT, "ZZZnope"), MISSING);
});

test("get_graph rejects a name that doesn't exist, with the same wording", async () => {
  await assert.rejects(() => getSubgraph(PROJECT, "ZZZnope"), MISSING);
});

test("find_related rejects a name that doesn't exist", async () => {
  // Distinct from its legitimate empty result when embeddings are off.
  await assert.rejects(() => findRelated(PROJECT, "ZZZnope"), MISSING);
});

test("the not-found message names the project and points at search_code", async () => {
  await assert.rejects(() => getCallers(PROJECT, "ZZZnope"), (e) => {
    assert.match(e.message, new RegExp(`project "${PROJECT}"`));
    assert.match(e.message, /search_code/);
    return true;
  });
});

test("get_file_outline rejects a path that isn't indexed", async () => {
  await assert.rejects(
    () => getFileOutline(PROJECT, "src/does-not-exist.js"),
    /No indexed file at "src\/does-not-exist.js"/,
  );
});

test("a real symbol with no callers still returns an empty list", async () => {
  // The guard must not turn "genuinely nothing calls this" into an error --
  // that distinction is the entire point.
  const callers = await getCallers(PROJECT, "realFunction");
  assert.deepEqual(callers, []);
});

test("a Class::method suffix match is accepted, not rejected", async () => {
  // requireSymbol has to use the same matching rule as the query it guards,
  // or a bare method name that would have resolved gets refused.
  const rows = await getSymbol(PROJECT, "render");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Widget::render");
  await assert.doesNotReject(() => getCallers(PROJECT, "render"));
});

test("a real file with symbols still returns its outline", async () => {
  const outline = await getFileOutline(PROJECT, "src/real.js");
  assert.equal(outline.length, 2);
});

test("get_rules says 'rules', not 'history', for an unresolvable target", async () => {
  // resolveTarget is shared with the history queries, and its message ends by
  // offering the project-wide fallback -- which named the wrong noun here.
  await assert.rejects(() => getRules(PROJECT, "ZZZnope"), (e) => {
    assert.match(e.message, /project-wide rules/);
    assert.doesNotMatch(e.message, /project-wide history/);
    return true;
  });
});
