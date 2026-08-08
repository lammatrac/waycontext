import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  searchDirs, findProjectMarker, positionals, needsProjectName, fillArgs,
} from "../src/projectResolve.js";
import { buildSection } from "../src/claudeMdInit.js";
import { operations, findOperation } from "../src/operations.js";

/** A temp repo with a .git marker, plus any extra directories. */
const repo = (...dirs) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wc-resolve-")));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

const writeMarker = (dir, file, name) => {
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# Project Notes\n\n${buildSection(name)}\n`);
  return abs;
};

test("the name is read from CLAUDE.md in the current directory", () => {
  const root = repo();
  const abs = writeMarker(root, "CLAUDE.md", "my-app");
  assert.deepEqual(findProjectMarker(root), { name: "my-app", file: abs, root });
});

// Running the CLI from src/ or a subpackage is normal; it must still resolve.
test("the walk climbs out of a subdirectory to find the marker", () => {
  const root = repo("src/deep");
  const abs = writeMarker(root, "CLAUDE.md", "my-app");
  const found = findProjectMarker(path.join(root, "src", "deep"));
  assert.equal(found.name, "my-app");
  assert.equal(found.file, abs);
  assert.equal(found.root, root, "root is the marker's directory, not the cwd");
});

// Escaping the checkout would pick up a parent repo's project, or the user's
// ~/CLAUDE.md, and index the wrong tree.
test("the walk stops at the git root", () => {
  const outer = repo("inner");
  writeMarker(outer, "CLAUDE.md", "outer-app");
  const inner = path.join(outer, "inner");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  assert.equal(findProjectMarker(inner), null);
  assert.deepEqual(searchDirs(inner), [inner]);
});

test("AGENTS.md is used when CLAUDE.md is absent", () => {
  const root = repo();
  const abs = writeMarker(root, "AGENTS.md", "my-app");
  assert.equal(findProjectMarker(root).file, abs);
});

test("CLAUDE.md wins over AGENTS.md when both name a project", () => {
  const root = repo();
  const claude = writeMarker(root, "CLAUDE.md", "from-claude");
  writeMarker(root, "AGENTS.md", "from-agents");
  const found = findProjectMarker(root);
  assert.equal(found.name, "from-claude");
  assert.equal(found.file, claude);
});

// A hand-edited section that lost its bolded name must not resolve to "" or
// crash -- it has to fall through to the prompt like a missing file.
test("a section with the name hand-removed does not resolve", () => {
  const root = repo();
  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    "# Project Notes\n\n## WayContext\n\nSome hand-written notes.\n"
  );
  assert.equal(findProjectMarker(root), null);
});

test("no marker anywhere resolves to null", () => {
  assert.equal(findProjectMarker(repo()), null);
});

test("searchDirs includes the start directory and ends at the git root", () => {
  const root = repo("a/b");
  const dirs = searchDirs(path.join(root, "a", "b"));
  assert.deepEqual(dirs, [path.join(root, "a", "b"), path.join(root, "a"), root]);
});

const index = findOperation("index");
const search = findOperation("search");
const overview = findOperation("project_overview");
const list = findOperation("list_projects");
const at = { name: "my-app", root: "/repo" };

test("a fully specified invocation is left exactly as it was", () => {
  const argv = ["other-app", "/srv/other"];
  const result = fillArgs(index, argv, at);
  assert.deepEqual(result.argv, argv);
  assert.equal(result.usedProject, false);
  assert.equal(result.usedRoot, false);
  assert.equal(needsProjectName(index, argv), false);
});

test("index with no arguments takes both the name and the root", () => {
  const result = fillArgs(index, [], at);
  assert.deepEqual(result.argv, ["my-app", "/repo"]);
  assert.deepEqual([result.usedProject, result.usedRoot], [true, true]);
});

// Right-first: the lone argument is the project name a human meant, not a path.
test("index with one argument keeps it as the project name", () => {
  const result = fillArgs(index, ["other-app"], at);
  assert.deepEqual(result.argv, ["other-app", "/repo"]);
  assert.deepEqual([result.usedProject, result.usedRoot], [false, true]);
  assert.equal(needsProjectName(index, ["other-app"]), false, "no prompt needed");
});

test("a query-shaped command takes only the project name", () => {
  const result = fillArgs(search, ["cache purge"], at);
  assert.deepEqual(result.argv, ["my-app", "cache purge"]);
  assert.deepEqual([result.usedProject, result.usedRoot], [true, false]);
  assert.equal(needsProjectName(search, ["cache purge"]), true);
});

test("an explicit project name always wins", () => {
  const argv = ["other-app", "cache purge"];
  assert.deepEqual(fillArgs(search, argv, at).argv, argv);
});

test("a single-argument command is filled from nothing", () => {
  assert.deepEqual(fillArgs(overview, [], at).argv, ["my-app"]);
  assert.equal(needsProjectName(overview, []), true);
});

test("an operation that takes no project is never touched", () => {
  assert.equal(needsProjectName(list, []), false);
  assert.deepEqual(fillArgs(list, [], at).argv, []);
});

test("optional trailing arguments do not trigger a fill", () => {
  // search_code's `limit` has a zod default, so it is not a required argument.
  assert.equal(needsProjectName(search, ["my-app", "cache purge"]), false);
});

test("flags are ignored when counting positionals and dropped from the result", () => {
  assert.deepEqual(positionals(["--json", "cache purge"]), ["cache purge"]);
  assert.deepEqual(fillArgs(search, ["--json", "cache purge"], at).argv, ["my-app", "cache purge"]);
});

// rootDefault must name the last positional -- fillArgs appends it.
test("rootDefault names the last cli argument of every operation that declares it", () => {
  for (const op of operations) {
    if (!op.cli?.rootDefault) continue;
    assert.equal(op.cli.rootDefault, op.cli.args.at(-1), `${op.name}`);
  }
});

test("index_project declares rootDefault", () => {
  assert.equal(index.cli.rootDefault, "path");
});
