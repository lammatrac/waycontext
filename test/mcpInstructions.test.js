import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildInstructions } from "../src/mcpInstructions.js";

function withCache(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-instructions-"));
  const file = path.join(dir, "projects.json");
  if (contents !== null) fs.writeFileSync(file, contents);
  return file;
}

const CACHE = JSON.stringify({
  version: 1,
  mcpName: "waycontext",
  mode: "advise",
  projects: [
    { name: "zebra", root_path: "/srv/zebra" },
    { name: "my-app", root_path: "/srv/my-app" },
    { name: "my-app-admin", root_path: "/srv/my-app/admin" },
  ],
});

test("instructions state the workflow and name the tools it refers to", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache(CACHE) });
  for (const tool of ["project_overview", "search_code", "get_callers", "get_graph", "get_symbol"]) {
    assert.match(text, new RegExp(tool), `the workflow must name ${tool}`);
  }
});

// The entire point of the field: a client's agent has to come away knowing
// these tools outrank its built-in search for indexed code.
test("instructions say to prefer these tools over the agent's own search", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache(CACHE) });
  assert.match(text, /BEFORE grep\/glob/);
});

// ...and where not to. An agent that takes "always use WayContext" literally
// wastes calls searching a symbol index for lockfiles and log output.
test("instructions say what WayContext is not for", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache(CACHE) });
  assert.match(text, /Do NOT reach for these tools/);
  assert.match(text, /lockfiles|logs|config/);
  assert.match(text, /only as fresh as the last index_project/);
});

// Every tool takes a required `project`. Without the list here the agent must
// spend a list_projects round-trip before its first real query -- and a tool
// costing two calls loses to a grep costing one.
test("instructions list the indexed projects with their roots", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache(CACHE) });
  assert.match(text, /- my-app -- \/srv\/my-app$/m);
  assert.match(text, /- zebra -- \/srv\/zebra$/m);
});

test("the project containing the cwd is called out", () => {
  const text = buildInstructions({ cwd: "/srv/my-app/src/web", cacheFile: withCache(CACHE) });
  assert.match(text, /current working directory is inside "my-app"/);
});

// A project nested inside another indexed root must resolve to the inner one,
// or the agent is handed the wrong project name for every query it makes.
test("the deepest matching root wins for a nested project", () => {
  const text = buildInstructions({ cwd: "/srv/my-app/admin/inc", cacheFile: withCache(CACHE) });
  assert.match(text, /current working directory is inside "my-app-admin"/);
});

// A repo indexed twice under different names is common -- an abandoned trial
// index outlives the real one in the cache. Naming one of them in the system
// prompt as "almost certainly" correct is a coin flip presented as a fact.
test("two projects sharing a root are both named instead of one being guessed", () => {
  const file = withCache(JSON.stringify({
    version: 1,
    projects: [
      { name: "smoke-test", root_path: "/srv/my-app" },
      { name: "my-app", root_path: "/srv/my-app" },
    ],
  }));
  const text = buildInstructions({ cwd: "/srv/my-app/src", cacheFile: file });
  assert.match(text, /matches more than one indexed project/);
  assert.match(text, /"my-app", "smoke-test"/);
  assert.doesNotMatch(text, /almost certainly/);
});

test("a cwd outside every indexed root says so rather than guessing", () => {
  const text = buildInstructions({ cwd: "/elsewhere", cacheFile: withCache(CACHE) });
  assert.match(text, /not inside any indexed root/);
});

// This runs on the connection handshake. Anything that throws here costs the
// agent every tool, so a bad cache must degrade to the static half instead.
test("a missing cache still yields usable instructions", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache(null) });
  assert.match(text, /search_code/);
  assert.match(text, /No projects are indexed yet/);
});

test("a corrupt cache still yields usable instructions", () => {
  const text = buildInstructions({ cwd: "/tmp", cacheFile: withCache("{ not json") });
  assert.match(text, /search_code/);
  assert.match(text, /No projects are indexed yet/);
});

test("an empty project list points at index_project rather than listing nothing", () => {
  const file = withCache(JSON.stringify({ version: 1, projects: [] }));
  assert.match(buildInstructions({ cwd: "/tmp", cacheFile: file }), /Run `index_project/);
});
