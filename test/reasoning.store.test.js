import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb, getOrCreateProject } = await import("../src/db.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");
const { config } = await import("../src/config.js");
const { createReasoningGraph, updateReasoningGraph } = await import("../src/reasoning/store.js");

const PROJECT = "reasoning_store_fixture";
let root;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-reasoning-"));
  await getOrCreateProject(PROJECT, root);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (root) fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
});

test("createReasoningGraph writes graph.json and reasoning.html under the configured dir", async () => {
  const result = await createReasoningGraph(PROJECT, { feature: "Forgot password" });
  assert.equal(result.slug, "forgot-password");

  const dir = path.join(root, config.reasoningDir, "forgot-password");
  assert.equal(result.graph_path, path.join(dir, "graph.json"));
  assert.equal(result.html_path, path.join(dir, "reasoning.html"));

  const graph = JSON.parse(fs.readFileSync(result.graph_path, "utf8"));
  assert.equal(graph.feature, "Forgot password");
  assert.ok(fs.readFileSync(result.html_path, "utf8").includes("Forgot password"));
});

test("createReasoningGraph refuses to overwrite an existing slug", async () => {
  await createReasoningGraph(PROJECT, { feature: "Reset email", slug: "reset-email" });
  await assert.rejects(
    () => createReasoningGraph(PROJECT, { feature: "Reset email again", slug: "reset-email" }),
    /reset-email/
  );
});

test("updateReasoningGraph applies patches cumulatively across calls, re-reading from disk each time", async () => {
  const created = await createReasoningGraph(PROJECT, { feature: "Change password", slug: "change-password" });
  await updateReasoningGraph(PROJECT, {
    slug: "change-password",
    patch: JSON.stringify([{ op: "add_node", parent: "n1", type: "question", title: "Q1" }]),
  });
  const second = await updateReasoningGraph(PROJECT, {
    slug: "change-password",
    patch: JSON.stringify([{ op: "add_node", parent: "n1", type: "question", title: "Q2" }]),
  });
  const graph = JSON.parse(fs.readFileSync(created.graph_path, "utf8"));
  assert.equal(Object.keys(graph.nodes).length, 3);
  assert.equal(second.node_count, 3);
});

test("a hand-edit to graph.json between two updateReasoningGraph calls is respected by the next call", async () => {
  const created = await createReasoningGraph(PROJECT, { feature: "Delete account", slug: "delete-account" });
  const graph = JSON.parse(fs.readFileSync(created.graph_path, "utf8"));
  graph.nodes.hand = { id: "hand", type: "question", title: "Hand-added", status: "open", children: [] };
  graph.nodes.n1.children.push("hand");
  fs.writeFileSync(created.graph_path, JSON.stringify(graph, null, 2));

  await updateReasoningGraph(PROJECT, {
    slug: "delete-account",
    patch: JSON.stringify([{ op: "set_status", node: "hand", status: "resolved" }]),
  });
  const after = JSON.parse(fs.readFileSync(created.graph_path, "utf8"));
  assert.equal(after.nodes.hand.status, "resolved");
});

test("a malformed hand-edit surfaces a validation error instead of corrupting further", async () => {
  const created = await createReasoningGraph(PROJECT, { feature: "Broken graph", slug: "broken-graph" });
  const graph = JSON.parse(fs.readFileSync(created.graph_path, "utf8"));
  graph.nodes = ["not", "a", "map"];
  fs.writeFileSync(created.graph_path, JSON.stringify(graph, null, 2));

  await assert.rejects(() =>
    updateReasoningGraph(PROJECT, { slug: "broken-graph", patch: JSON.stringify([{ op: "set_risk", node: "n1", risk: "low" }]) })
  );
});

test("updateReasoningGraph on an unknown slug throws a clear not-found error", async () => {
  await assert.rejects(
    () => updateReasoningGraph(PROJECT, { slug: "does-not-exist", patch: "[]" }),
    /does-not-exist/
  );
});
