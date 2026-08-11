import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MARKDOWN_TARGETS, selectTargets, skippedTargets, mergeVscodeMcp, planMarkdownWrite,
} from "../src/initTargets.js";
import { extractExistingPath } from "../src/claudeMdInit.js";

const repo = (...dirs) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-init-"));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

// init only wrote CLAUDE.md before this, which is why everything it said was
// invisible to Copilot and Cursor -- the clients most likely to fall back to
// their own search.
test("the target list covers the non-Claude clients", () => {
  const paths = MARKDOWN_TARGETS.map((t) => t.path);
  assert.ok(paths.includes("CLAUDE.md"));
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(paths.includes(path.join(".github", "copilot-instructions.md")));
});

test("copilot-instructions is written when the repo already uses .github/", () => {
  const selected = selectTargets(repo(".github")).map((t) => t.path);
  assert.ok(selected.includes(path.join(".github", "copilot-instructions.md")));
});

// Creating a .github/ in a repo that deliberately has none is a bigger
// imposition than a root-level markdown file, so it needs asking for.
test("copilot-instructions is skipped, not silently created, without a .github/", () => {
  const root = repo();
  const selected = selectTargets(root).map((t) => t.path);
  assert.ok(!selected.includes(path.join(".github", "copilot-instructions.md")));
  assert.deepEqual(skippedTargets(root).map((t) => t.dependsOnDir), [".github"]);
});

test("--all overrides the directory check", () => {
  assert.equal(selectTargets(repo(), { all: true }).length, MARKDOWN_TARGETS.length);
});

test("root-level targets are always written", () => {
  const selected = selectTargets(repo()).map((t) => t.path);
  assert.deepEqual(selected, ["CLAUDE.md", "AGENTS.md"]);
});

test("planMarkdownWrite reports no change on a second run", () => {
  const root = repo();
  const target = MARKDOWN_TARGETS[0];
  const first = planMarkdownWrite(root, target, "my-app");
  assert.equal(first.changed, true);
  assert.equal(first.mode, "created");

  fs.writeFileSync(first.abs, first.content);
  assert.equal(planMarkdownWrite(root, target, "my-app").changed, false);
});

test("planMarkdownWrite plumbs a root path through to the written section", () => {
  const root = repo();
  const target = MARKDOWN_TARGETS[0];
  const { content } = planMarkdownWrite(root, target, "my-app", "./");
  assert.equal(extractExistingPath(content), "./");
});

test("mergeVscodeMcp registers the server in a fresh file", () => {
  const { content, mode } = mergeVscodeMcp("");
  assert.equal(mode, "created");
  assert.deepEqual(JSON.parse(content).servers.waycontext, { command: "waycontext-mcp" });
});

test("mergeVscodeMcp preserves other servers and unrelated keys", () => {
  const existing = JSON.stringify({ inputs: [{ id: "tok" }], servers: { other: { command: "x" } } });
  const { content, mode } = mergeVscodeMcp(existing);
  assert.equal(mode, "appended");
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.servers.other, { command: "x" });
  assert.deepEqual(parsed.inputs, [{ id: "tok" }]);
  assert.equal(parsed.servers.waycontext.command, "waycontext-mcp");
});

test("mergeVscodeMcp is a no-op when already registered", () => {
  const existing = JSON.stringify({ servers: { waycontext: { command: "waycontext-mcp" } } }, null, 2);
  const { content, mode } = mergeVscodeMcp(existing);
  assert.equal(mode, "unchanged");
  assert.equal(content, existing, "a re-run must not reformat the file");
});

// VS Code tolerates comments and trailing commas in mcp.json. Reserializing one
// would destroy whatever else the user has registered there, so refuse instead.
test("mergeVscodeMcp refuses to rewrite a file it cannot parse", () => {
  const jsonc = '{\n  // my servers\n  "servers": { "other": { "command": "x" } },\n}\n';
  const { content, mode } = mergeVscodeMcp(jsonc);
  assert.equal(mode, "unparseable");
  assert.equal(content, jsonc);
});

test("mergeVscodeMcp keeps extra fields on an existing entry while fixing the command", () => {
  const existing = JSON.stringify({ servers: { waycontext: { command: "old", env: { A: "1" } } } });
  const { content, mode } = mergeVscodeMcp(existing);
  assert.equal(mode, "updated");
  assert.deepEqual(JSON.parse(content).servers.waycontext, { command: "waycontext-mcp", env: { A: "1" } });
});
