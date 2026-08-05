import { test } from "node:test";
import assert from "node:assert/strict";
import { newGraph } from "../src/reasoning/schema.js";
import { applyPatch } from "../src/reasoning/patch.js";
import { renderHtml } from "../src/reasoning/render.js";

function graphWithQuestion(title = "Should email existence be exposed?") {
  let graph = newGraph({ feature: "Forgot password", slug: "forgot-password", now: "2026-08-05T12:00:00.000Z" });
  graph = applyPatch(graph, [{ op: "add_node", parent: "n1", type: "question", title }]);
  graph = applyPatch(graph, [{ op: "add_alternative", node: "n2", label: "Generic message", pros: ["safe"], cons: ["worse UX"] }]);
  graph = applyPatch(graph, [{ op: "select_answer", node: "n2", alternative: "a1" }]);
  graph = applyPatch(graph, [{ op: "set_affected_files", node: "n2", files: ["src/auth/forgotPassword.js"] }]);
  return graph;
}

function extractEmbeddedGraph(html) {
  const match = html.match(/<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "expected an embedded graph-data script tag");
  return JSON.parse(match[1]);
}

test("renderHtml embeds the graph as JSON that round-trips back to the source object", () => {
  const graph = graphWithQuestion();
  const html = renderHtml(graph);
  assert.deepEqual(extractEmbeddedGraph(html), graph);
});

test("renderHtml output has no external requests: no http(s) URLs, no external script src, no link tags", () => {
  const html = renderHtml(graphWithQuestion());
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[ >]/);
});

test("renderHtml includes the feature title and each node's title as visible text", () => {
  const graph = graphWithQuestion();
  const html = renderHtml(graph);
  assert.match(html, /Forgot password/);
  assert.match(html, /Should email existence be exposed\?/);
});

test("renderHtml HTML-escapes node titles in the tree so markup can't break out", () => {
  const graph = graphWithQuestion("A & B <tag>");
  const html = renderHtml(graph);
  assert.match(html, /A &amp; B &lt;tag&gt;/);
});

test("a title containing a literal </script> does not truncate the embedded JSON", () => {
  const graph = graphWithQuestion("</script><script>alert(1)</script>");
  const html = renderHtml(graph);
  assert.deepEqual(extractEmbeddedGraph(html), graph);
});
