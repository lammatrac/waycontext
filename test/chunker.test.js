import test from "node:test";
import assert from "node:assert/strict";
import { splitSections, chunkMarkdown } from "../src/knowledge/chunker.js";

test("headings build a breadcrumb path", () => {
  const sections = splitSections(
    "# Title\nintro\n\n## Storage\nabout storage\n\n### Chunking\ndetails\n"
  );
  const paths = sections.map((s) => s.headingPath);
  assert.deepEqual(paths, ["Title", "Title > Storage", "Title > Storage > Chunking"]);
});

test("a heading inside a fenced block is not a heading", () => {
  const sections = splitSections("# Real\n```md\n# Fake\n```\ntail\n");
  assert.equal(sections.length, 1);
  assert.match(sections[0].content, /# Fake/);
});

test("text before the first heading becomes its own section", () => {
  const sections = splitSections("preamble text\n\n# Later\nbody\n");
  assert.equal(sections[0].headingPath, "");
  assert.match(sections[0].content, /preamble/);
});

test("a fenced code block is never split even when it exceeds the target", () => {
  const code = "```js\n" + "const x = 1;\n".repeat(400) + "```";
  const chunks = chunkMarkdown(`# Big\n${code}\n`, { target: 500, hardCap: 8000 });
  const holding = chunks.filter((c) => c.content.includes("const x = 1;"));
  assert.equal(holding.length, 1, "the block landed in exactly one chunk");
  const fences = holding[0].content.match(/```/g) || [];
  assert.equal(fences.length % 2, 0, "fences stay balanced");
});

test("content longer than hardCap is truncated to hardCap", () => {
  const chunks = chunkMarkdown("# H\n" + "x".repeat(20000), { target: 4800, hardCap: 8000 });
  for (const c of chunks) assert.ok(c.content.length <= 8000, `${c.content.length} <= 8000`);
});

test("ords are dense and ascending", () => {
  const doc = ["# A", "a".repeat(3000), "## B", "b".repeat(3000), "## C", "c".repeat(3000)].join("\n\n");
  const chunks = chunkMarkdown(doc, { target: 2000 });
  assert.deepEqual(chunks.map((c) => c.ord), chunks.map((_, i) => i));
});

test("small sibling subsections merge, major sections do not", () => {
  const doc = "# T\n## One\ntiny\n### Sub\nalso tiny\n\n## Two\nmore\n";
  const chunks = chunkMarkdown(doc, { target: 4800 });
  assert.ok(chunks.length >= 2, "## Two starts a new chunk");
  assert.ok(chunks[0].content.includes("also tiny"), "### Sub merged into its parent");
  assert.ok(!chunks[0].content.includes("more"));
});

test("a heading with no body of its own rides on the next chunk", () => {
  const chunks = chunkMarkdown("# Use RRF\n## Context\nwhy\n", { target: 4800 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /^# Use RRF/);
  assert.match(chunks[0].content, /## Context/);
  assert.equal(chunks[0].headingPath, "Use RRF > Context");
});

test("a trailing heading with nothing after it is still stored", () => {
  const chunks = chunkMarkdown("# T\nbody\n\n## Empty Tail\n", { target: 4800 });
  assert.ok(chunks.some((c) => c.content.includes("## Empty Tail")));
});

test("editing one section changes only that section's hash", () => {
  const before = chunkMarkdown("# T\n## A\nalpha\n\n## B\nbeta\n", { target: 40 });
  const after = chunkMarkdown("# T\n## A\nalpha\n\n## B\nBETA CHANGED\n", { target: 40 });
  assert.equal(before[0].contentHash, after[0].contentHash);
  assert.notEqual(before.at(-1).contentHash, after.at(-1).contentHash);
});

test("token estimate is roughly a quarter of the characters", () => {
  const [chunk] = chunkMarkdown("# T\n" + "y".repeat(400), { target: 4800 });
  assert.ok(chunk.tokenEstimate >= 90 && chunk.tokenEstimate <= 120, String(chunk.tokenEstimate));
});
