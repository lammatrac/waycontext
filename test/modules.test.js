import test from "node:test";
import assert from "node:assert/strict";
import {
  modulePathFor, moduleNameFor, moduleDepthOf, groupFilesIntoModules,
} from "../src/knowledge/modules.js";

test("a module is the file's directory, capped at the configured depth", () => {
  assert.equal(modulePathFor("src/knowledge/rules.js", 2), "src/knowledge");
  assert.equal(modulePathFor("src/knowledge/rules.js", 1), "src");
  assert.equal(modulePathFor("src/cli.js", 2), "src", "shallower than the cap is fine");
  assert.equal(modulePathFor("a/b/c/d/e.js", 3), "a/b/c");
});

test("root files get their own module rather than being dropped", () => {
  // package.json and README.md are usually the most-touched files in a repo;
  // silently having no module would leave them out of every metric.
  assert.equal(modulePathFor("README.md", 2), ".");
  assert.equal(moduleNameFor("."), "(root)");
  assert.equal(moduleDepthOf("."), 0);
});

test("depth 0 or negative still yields one level rather than an empty path", () => {
  assert.equal(modulePathFor("src/knowledge/rules.js", 0), "src");
  assert.equal(modulePathFor("src/knowledge/rules.js", -3), "src");
});

test("names and depths come off the path", () => {
  assert.equal(moduleNameFor("src/knowledge"), "knowledge");
  assert.equal(moduleDepthOf("src/knowledge"), 2);
  assert.equal(moduleDepthOf("src"), 1);
});

test("grouping sums loc and symbols per module and is ordered by path", () => {
  const grouped = groupFilesIntoModules([
    { id: 3, path: "src/knowledge/rules.js", loc: 400, symbols: 12 },
    { id: 1, path: "README.md", loc: 900, symbols: 0 },
    { id: 2, path: "src/cli.js", loc: 600, symbols: 8 },
    { id: 4, path: "src/knowledge/memory.js", loc: 200, symbols: 6 },
  ], 2);

  assert.deepEqual(grouped.map((m) => m.path), [".", "src", "src/knowledge"]);
  const knowledge = grouped.find((m) => m.path === "src/knowledge");
  assert.equal(knowledge.fileCount, 2);
  assert.equal(knowledge.loc, 600);
  assert.equal(knowledge.symbolCount, 18);
  assert.deepEqual(knowledge.fileIds.sort(), [3, 4]);
});

test("missing loc and symbol counts count as zero, not NaN", () => {
  const [mod] = groupFilesIntoModules([{ id: 1, path: "src/a.js" }], 2);
  assert.equal(mod.loc, 0);
  assert.equal(mod.symbolCount, 0);
  assert.equal(mod.fileCount, 1);
});
