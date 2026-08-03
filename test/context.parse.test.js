import test from "node:test";
import assert from "node:assert/strict";
import { parseTask } from "../src/context/parse.js";

test("paths and identifiers are pulled out of a plain-language task", () => {
  const p = parseTask("fix the retry logic in indexProject so src/indexer.js stops wedging");
  assert.ok(p.identifiers.includes("indexProject"), p.identifiers.join(","));
  assert.ok(p.paths.includes("src/indexer.js"), p.paths.join(","));
});

test("backticks make a word an identifier even when it doesn't look like one", () => {
  // The strongest signal a human gives that a word is code. Without this,
  // `charge` is indistinguishable from the English word.
  const p = parseTask("why does `charge` double-bill");
  assert.deepEqual(p.identifiers, ["charge"]);
});

test("a backticked path is a path, not an identifier", () => {
  const p = parseTask("update `src/graph.js` please");
  assert.deepEqual(p.paths, ["src/graph.js"]);
  assert.deepEqual(p.identifiers, []);
});

test("quoted phrases are kept whole", () => {
  const p = parseTask('find where we log "payment declined" to the console');
  assert.deepEqual(p.phrases, ["payment declined"]);
});

test("identifier shapes: camel, Pascal, snake, constant and Class::method", () => {
  const p = parseTask("check writeModules, BugCluster, module_deps, MAX_FILE_SIZE and Parser::run");
  for (const want of ["writeModules", "BugCluster", "module_deps", "MAX_FILE_SIZE", "Parser::run"]) {
    assert.ok(p.identifiers.includes(want), `missing ${want} in ${p.identifiers.join(",")}`);
  }
});

test("english prose is not mistaken for a path", () => {
  // "and/or" has a slash and would match a naive path regex.
  const p = parseTask("handle this and/or that");
  assert.deepEqual(p.paths, []);
});

test("terms exclude stopwords and anything already claimed as a path or symbol", () => {
  const p = parseTask("fix the retry logic in indexProject so src/indexer.js stops wedging");
  assert.ok(p.terms.includes("retry"));
  assert.ok(p.terms.includes("wedging"));
  assert.ok(!p.terms.includes("the"), "stopword");
  assert.ok(!p.terms.includes("indexproject"), "already an identifier");
  assert.ok(!p.terms.includes("indexer"), "already part of a path");
});

test("an empty or absent task parses to empty rather than throwing", () => {
  for (const input of ["", "   ", null, undefined]) {
    const p = parseTask(input);
    assert.deepEqual([p.paths, p.identifiers, p.phrases, p.terms], [[], [], [], []]);
  }
});

test("duplicate mentions are collapsed", () => {
  const p = parseTask("indexProject calls indexProject in src/indexer.js and src/indexer.js");
  assert.deepEqual(p.identifiers, ["indexProject"]);
  assert.deepEqual(p.paths, ["src/indexer.js"]);
});
