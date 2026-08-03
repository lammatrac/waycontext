import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  classifyDoc,
  extractAdrSections,
  extractMentions,
  parseDocument,
} from "../src/knowledge/docs.js";
import { splitSections } from "../src/knowledge/chunker.js";

test("frontmatter scalars, inline lists and block lists all parse", () => {
  const { frontmatter, body } = parseFrontmatter(
    "---\ntitle: My Doc\nstatus: accepted\ntags: [a, b]\nowners:\n  - trac\n  - sam\n---\nbody text\n"
  );
  assert.equal(frontmatter.title, "My Doc");
  assert.equal(frontmatter.status, "accepted");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
  assert.deepEqual(frontmatter.owners, ["trac", "sam"]);
  assert.equal(body.trim(), "body text");
});

test("a document with no frontmatter is returned unchanged", () => {
  const { frontmatter, body } = parseFrontmatter("# Title\ntext\n");
  assert.deepEqual(frontmatter, {});
  assert.match(body, /^# Title/);
});

test("a horizontal rule is not mistaken for frontmatter", () => {
  const { frontmatter, body } = parseFrontmatter("---\n# Title\ntext\n");
  assert.deepEqual(frontmatter, {});
  assert.match(body, /# Title/);
});

test("doc_type comes from the path, the filename or the headings", () => {
  const adrSections = splitSections("# Use Postgres\n## Context\nc\n## Decision\nd\n");
  assert.equal(classifyDoc("docs/adr/0003-use-postgres.md", [], {}), "adr");
  assert.equal(classifyDoc("notes/0003-use-postgres.md", [], {}), "adr");
  assert.equal(classifyDoc("notes/whatever.md", [], { status: "Accepted" }), "adr");
  assert.equal(classifyDoc("notes/whatever.md", adrSections, {}), "adr");
  assert.equal(classifyDoc("README.md", [], {}), "readme");
  assert.equal(classifyDoc("CHANGELOG.md", [], {}), "changelog");
  assert.equal(classifyDoc("CONTRIBUTING.md", [], {}), "contributing");
  assert.equal(classifyDoc("docs/setup.md", [], {}), "guide");
  assert.equal(classifyDoc("random/thoughts.md", [], {}), "note");
});

test("ADR sections are extracted under their common aliases", () => {
  const sections = splitSections(
    "# T\n## Status\nAccepted\n## Context\nthe why\n## Decision\nwe chose X\n## Outcome\nwe live with Y\n"
  );
  const adr = extractAdrSections(sections, {});
  assert.equal(adr.status, "Accepted");
  assert.match(adr.context, /the why/);
  assert.match(adr.decision, /we chose X/);
  assert.match(adr.consequences, /we live with Y/);
});

test("frontmatter status beats a Status heading", () => {
  const sections = splitSections("# T\n## Status\nProposed\n## Decision\nd\n");
  assert.equal(extractAdrSections(sections, { status: "superseded" }).status, "superseded");
});

test("a non-ADR document yields no ADR block", () => {
  assert.equal(extractAdrSections(splitSections("# T\nprose\n"), {}), null);
});

test("mentions come from paths anywhere and identifiers only from backticks", () => {
  const m = extractMentions(
    "The resolver in src/graph.js calls `searchCode` and `Foo::bar`.\n" +
      "Plain searchCode in prose is ignored, and `not an identifier` too.\n"
  );
  assert.deepEqual(m.paths, ["src/graph.js"]);
  assert.deepEqual(m.identifiers.sort(), ["Foo::bar", "searchCode"]);
});

test("fenced code contributes no mentions", () => {
  const m = extractMentions("```js\nimport { hidden } from './hidden.js';\n`inFence`\n```\ntext\n");
  assert.deepEqual(m.paths, []);
  assert.deepEqual(m.identifiers, []);
});

test("a mentioned path must look like a source file", () => {
  const m = extractMentions("see docs/adr/0003-x.md and http://example.com/a/b.html and a/b.js");
  assert.ok(m.paths.includes("docs/adr/0003-x.md"));
  assert.ok(m.paths.includes("a/b.js"));
  assert.ok(!m.paths.some((p) => p.includes("example.com")));
});

test("parseDocument composes title, type, adr, mentions and chunks", () => {
  const doc = parseDocument(
    "docs/adr/0007-chunking.md",
    "---\nstatus: accepted\n---\n# Chunk at 4800 chars\n## Context\n`chunkMarkdown` in src/knowledge/chunker.js\n## Decision\nsplit on sections\n"
  );
  assert.equal(doc.title, "Chunk at 4800 chars");
  assert.equal(doc.docType, "adr");
  assert.equal(doc.adr.status, "accepted");
  assert.deepEqual(doc.mentions.identifiers, ["chunkMarkdown"]);
  assert.deepEqual(doc.mentions.paths, ["src/knowledge/chunker.js"]);
  assert.ok(doc.chunks.length >= 1);
  assert.equal(doc.chunks[0].ord, 0);
});

test("title falls back to the filename when there is no heading", () => {
  assert.equal(parseDocument("notes/thing-one.md", "just prose\n").title, "thing-one");
});
