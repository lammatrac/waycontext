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

test("createReasoningGraph writes graph.json and waycontext-review.html under the configured dir", async () => {
  const prevAutoOpen = config.reasoningAutoOpen;
  try {
    config.reasoningAutoOpen = false;

    const result = await createReasoningGraph(PROJECT, { feature: "Forgot password" });
    assert.equal(result.slug, "forgot-password");

    const dir = path.join(root, config.reasoningDir, "forgot-password");
    assert.equal(result.graph_path, path.join(dir, "graph.json"));
    assert.equal(result.html_path, path.join(dir, "waycontext-review.html"));

    const graph = JSON.parse(fs.readFileSync(result.graph_path, "utf8"));
    assert.equal(graph.feature, "Forgot password");
    assert.ok(fs.existsSync(path.join(dir, "reasoning.html")));
    assert.ok(fs.readFileSync(result.html_path, "utf8").includes("Forgot password"));
    assert.equal(result.auto_open.enabled, false);
  } finally {
    config.reasoningAutoOpen = prevAutoOpen;
  }
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

test("createReasoningGraph auto-opens the generated review file when REASONING_AUTO_OPEN is enabled", async () => {
  const prevAutoOpen = config.reasoningAutoOpen;
  try {
    config.reasoningAutoOpen = true;

    const opened = [];
    const result = await createReasoningGraph(
      PROJECT,
      { feature: "Auto open smoke", slug: "auto-open-smoke" },
      {
        openFile: async (filePath) => {
          opened.push(filePath);
          return { command: "mock-open", args: [filePath] };
        },
      }
    );

    assert.equal(opened.length, 1);
    assert.equal(opened[0], result.html_path);
    assert.equal(result.auto_open.enabled, true);
    assert.equal(result.auto_open.attempted, true);
    assert.equal(result.auto_open.opened, true);
  } finally {
    config.reasoningAutoOpen = prevAutoOpen;
  }
});

test("updateReasoningGraph reports auto-open failures without failing the patch", async () => {
  const prevAutoOpen = config.reasoningAutoOpen;
  try {
    config.reasoningAutoOpen = true;

    await createReasoningGraph(PROJECT, { feature: "Auto open failure", slug: "auto-open-failure" });
    const result = await updateReasoningGraph(
      PROJECT,
      {
        slug: "auto-open-failure",
        patch: JSON.stringify([{ op: "add_node", parent: "n1", type: "question", title: "Q" }]),
      },
      {
        openFile: async () => {
          throw new Error("launcher missing");
        },
      }
    );

    assert.equal(result.node_count, 2);
    assert.equal(result.auto_open.enabled, true);
    assert.equal(result.auto_open.attempted, true);
    assert.equal(result.auto_open.opened, false);
    assert.match(result.auto_open.warning, /launcher missing/);
  } finally {
    config.reasoningAutoOpen = prevAutoOpen;
  }
});
