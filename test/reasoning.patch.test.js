import { test } from "node:test";
import assert from "node:assert/strict";
import { newGraph } from "../src/reasoning/schema.js";
import { applyPatch } from "../src/reasoning/patch.js";

function baseGraph() {
  return newGraph({ feature: "Forgot password", slug: "forgot-password", now: "2026-08-05T12:00:00.000Z" });
}

test("add_node appends a new child with a generated id under the given parent", () => {
  const result = applyPatch(baseGraph(), [
    { op: "add_node", parent: "n1", type: "question", title: "Edge case?" },
  ]);
  assert.deepEqual(result.nodes.n1.children, ["n2"]);
  assert.equal(result.nodes.n2.title, "Edge case?");
  assert.equal(result.nodes.n2.type, "question");
  assert.equal(result.nodes.n2.status, "open");
});

test("add_node with an explicit id that already exists throws", () => {
  const graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q", id: "n2" }]);
  assert.throws(() => applyPatch(graph, [{ op: "add_node", parent: "n1", type: "question", title: "Q2", id: "n2" }]));
});

test("add_node with an unknown parent id throws naming the id", () => {
  assert.throws(
    () => applyPatch(baseGraph(), [{ op: "add_node", parent: "nope", type: "question", title: "Q" }]),
    /nope/
  );
});

test("add_alternative appends to the node's alternatives with a generated id", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q" }]);
  graph = applyPatch(graph, [
    { op: "add_alternative", node: "n2", label: "Option A", pros: ["fast"], cons: ["risky"] },
  ]);
  assert.equal(graph.nodes.n2.alternatives.length, 1);
  assert.equal(graph.nodes.n2.alternatives[0].label, "Option A");
  assert.ok(graph.nodes.n2.alternatives[0].id);
});

test("select_answer sets the node's selected alternative", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q" }]);
  graph = applyPatch(graph, [{ op: "add_alternative", node: "n2", label: "Option A" }]);
  const altId = graph.nodes.n2.alternatives[0].id;
  graph = applyPatch(graph, [{ op: "select_answer", node: "n2", alternative: altId }]);
  assert.equal(graph.nodes.n2.selected, altId);
});

test("select_answer with an alternative id the node doesn't have throws", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q" }]);
  assert.throws(() => applyPatch(graph, [{ op: "select_answer", node: "n2", alternative: "not-a-real-alt" }]));
});

test("set_status, set_risk, set_affected_files, set_notes, set_title mutate the named node", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q" }]);
  graph = applyPatch(graph, [
    { op: "set_status", node: "n2", status: "resolved" },
    { op: "set_risk", node: "n2", risk: "high" },
    { op: "set_affected_files", node: "n2", files: ["src/a.js"] },
    { op: "set_notes", node: "n2", notes: "because reasons" },
    { op: "set_title", node: "n2", title: "Renamed" },
  ]);
  assert.equal(graph.nodes.n2.status, "resolved");
  assert.equal(graph.nodes.n2.risk, "high");
  assert.deepEqual(graph.nodes.n2.affected_files, ["src/a.js"]);
  assert.equal(graph.nodes.n2.notes, "because reasons");
  assert.equal(graph.nodes.n2.title, "Renamed");
});

test("remove_node cascades to descendants and detaches from its parent's children", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "Q" }]);
  graph = applyPatch(graph, [{ op: "add_node", parent: "n2", type: "question", title: "Child" }]);
  graph = applyPatch(graph, [{ op: "remove_node", node: "n2" }]);
  assert.deepEqual(graph.nodes.n1.children, []);
  assert.equal(graph.nodes.n2, undefined);
  assert.equal(graph.nodes.n3, undefined);
});

test("remove_node refuses to remove the root", () => {
  assert.throws(() => applyPatch(baseGraph(), [{ op: "remove_node", node: "n1" }]));
});

test("reparent moves a node from one parent's children to another's", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "A" }]);
  graph = applyPatch(graph, [{ op: "add_node", parent: "n1", type: "question", title: "B" }]);
  graph = applyPatch(graph, [{ op: "reparent", node: "n3", parent: "n2" }]);
  assert.deepEqual(graph.nodes.n1.children, ["n2"]);
  assert.deepEqual(graph.nodes.n2.children, ["n3"]);
});

test("reparent under one of the node's own descendants throws instead of creating a cycle", () => {
  let graph = applyPatch(baseGraph(), [{ op: "add_node", parent: "n1", type: "question", title: "A" }]);
  graph = applyPatch(graph, [{ op: "add_node", parent: "n2", type: "question", title: "child of A" }]);
  assert.throws(() => applyPatch(graph, [{ op: "reparent", node: "n2", parent: "n3" }]));
});

test("an invalid op anywhere in the batch leaves the original graph object completely unmodified", () => {
  const graph = baseGraph();
  const before = structuredClone(graph);
  assert.throws(() =>
    applyPatch(graph, [
      { op: "add_node", parent: "n1", type: "question", title: "Q" },
      { op: "set_status", node: "does-not-exist", status: "resolved" },
    ])
  );
  assert.deepEqual(graph, before);
});

test("an unknown node id in any op throws an error naming that id", () => {
  assert.throws(() => applyPatch(baseGraph(), [{ op: "set_risk", node: "ghost", risk: "low" }]), /ghost/);
});
