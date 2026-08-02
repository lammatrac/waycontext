import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readProjectCache, writeProjectCache, projectForCwd,
  DEFAULT_MODE, DEFAULT_MCP_NAME,
} from "../src/projectCache.js";

let dir;
let file;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-cache-"));
  file = path.join(dir, "nested", "projects.json");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readProjectCache returns usable defaults when the file is missing", () => {
  const cache = readProjectCache(path.join(dir, "absent.json"));
  assert.equal(cache.mode, DEFAULT_MODE);
  assert.equal(cache.mcpName, DEFAULT_MCP_NAME);
  assert.deepEqual(cache.projects, []);
});

test("readProjectCache falls back to defaults on corrupt JSON", () => {
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{ not json");
  const cache = readProjectCache(corrupt);
  assert.equal(cache.mode, DEFAULT_MODE);
  assert.deepEqual(cache.projects, []);
});

test("readProjectCache rejects an unknown mode rather than passing it through", () => {
  const bogus = path.join(dir, "bogus-mode.json");
  fs.writeFileSync(bogus, JSON.stringify({ mode: "explode", projects: [] }));
  assert.equal(readProjectCache(bogus).mode, DEFAULT_MODE);
});

test("writeProjectCache creates missing directories and round-trips", () => {
  writeProjectCache({ mode: "deny", projects: [{ name: "a", root_path: "/tmp/a" }] }, file);
  const cache = readProjectCache(file);
  assert.equal(cache.mode, "deny");
  assert.deepEqual(cache.projects, [{ name: "a", root_path: "/tmp/a" }]);
  assert.ok(cache.updatedAt);
});

test("writing projects preserves the mode set by hook install", () => {
  writeProjectCache({ mode: "ask" }, file);
  writeProjectCache({ projects: [{ name: "b", root_path: "/tmp/b" }] }, file);
  const cache = readProjectCache(file);
  assert.equal(cache.mode, "ask", "an index must not reset the hook mode");
  assert.deepEqual(cache.projects, [{ name: "b", root_path: "/tmp/b" }]);
});

test("writeProjectCache keeps only name and root_path from richer project rows", () => {
  writeProjectCache(
    { projects: [{ name: "c", root_path: "/tmp/c", id: 7, symbol_count: "900", indexed_at: new Date() }] },
    file
  );
  assert.deepEqual(readProjectCache(file).projects, [{ name: "c", root_path: "/tmp/c" }]);
});

test("projectForCwd matches the root itself and any descendant", () => {
  const projects = [{ name: "api", root_path: "/srv/api" }];
  assert.equal(projectForCwd("/srv/api", projects).name, "api");
  assert.equal(projectForCwd("/srv/api/src/deep", projects).name, "api");
});

test("projectForCwd does not match a sibling with a shared prefix", () => {
  const projects = [{ name: "api", root_path: "/srv/api" }];
  assert.equal(projectForCwd("/srv/api-docs", projects), null);
});

test("projectForCwd picks the deepest matching root", () => {
  const projects = [
    { name: "monorepo", root_path: "/srv/mono" },
    { name: "web", root_path: "/srv/mono/apps/web" },
  ];
  assert.equal(projectForCwd("/srv/mono/apps/web/src", projects).name, "web");
  assert.equal(projectForCwd("/srv/mono/tools", projects).name, "monorepo");
});

test("projectForCwd tolerates a trailing slash on the stored root", () => {
  const projects = [{ name: "api", root_path: "/srv/api/" }];
  assert.equal(projectForCwd("/srv/api/src", projects).name, "api");
});

test("projectForCwd returns null when nothing is indexed", () => {
  assert.equal(projectForCwd("/anywhere", []), null);
});
