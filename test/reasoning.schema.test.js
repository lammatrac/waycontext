import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraph, newGraph, patchOpSchema } from "../src/reasoning/schema.js";

const MINIMAL = {
  schema_version: 1,
  feature: "Forgot password",
  slug: "forgot-password",
  created_at: "2026-08-05T12:00:00.000Z",
  updated_at: "2026-08-05T12:00:00.000Z",
  root_id: "n1",
  nodes: {
    n1: { id: "n1", type: "feature", title: "Forgot password", status: "open", children: [] },
  },
};

test("validateGraph accepts a minimal valid graph and fills in defaults", () => {
  const graph = validateGraph(MINIMAL);
  assert.equal(graph.feature, "Forgot password");
  assert.deepEqual(graph.nodes.n1.children, []);
  assert.equal(graph.nodes.n1.risk, null);
});

test("validateGraph rejects a graph missing root_id", () => {
  const bad = { ...MINIMAL, root_id: undefined };
  assert.throws(() => validateGraph(bad));
});

test("validateGraph rejects an unknown node type", () => {
  const bad = {
    ...MINIMAL,
    nodes: { n1: { ...MINIMAL.nodes.n1, type: "not-a-type" } },
  };
  assert.throws(() => validateGraph(bad));
});

test("validateGraph rejects nodes that is not an object map", () => {
  const bad = { ...MINIMAL, nodes: [MINIMAL.nodes.n1] };
  assert.throws(() => validateGraph(bad));
});

test("newGraph produces a single-root graph that passes validateGraph", () => {
  const graph = newGraph({ feature: "Forgot password", slug: "forgot-password", now: "2026-08-05T12:00:00.000Z" });
  const validated = validateGraph(graph);
  assert.equal(validated.root_id, validated.nodes[validated.root_id].id);
  assert.equal(validated.nodes[validated.root_id].type, "feature");
  assert.equal(validated.nodes[validated.root_id].title, "Forgot password");
});

test("patchOpSchema accepts a well-formed add_node op", () => {
  const op = { op: "add_node", parent: "n1", type: "question", title: "Edge case?" };
  assert.deepEqual(patchOpSchema.parse(op).op, "add_node");
});

test("patchOpSchema rejects an op with an unknown discriminator", () => {
  assert.throws(() => patchOpSchema.parse({ op: "not_a_real_op" }));
});
