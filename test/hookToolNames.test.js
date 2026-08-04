import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { operations } from "../src/operations.js";

/**
 * The search hook names five MCP tools in a shell string. Nothing checked that
 * those names still exist.
 *
 * Every other surface in this project is generated from the operation registry
 * precisely so it can't drift; the hook is a shell script, so it can't import
 * the registry and has to restate them. src/server.js records that a previous
 * name mismatch here is exactly what broke the hook before — the tools were
 * suggested under a prefix no client had registered, so the advice pointed at
 * nothing.
 */

const HOOK = new URL("../hooks/codectx-primary-search.sh", import.meta.url);

/** The tool basenames the hook tells the agent to prefer. */
function hookToolNames() {
  const source = fs.readFileSync(HOOK, "utf8");
  const line = source.match(/^tools=.*$/m);
  assert.ok(line, "expected a `tools=` assignment in the hook");
  return [...line[0].matchAll(/mcp__\$\{mcp_name\}__(\w+)/g)].map((m) => m[1]);
}

test("every tool the hook recommends is a real registry operation", () => {
  const names = new Set(operations.map((op) => op.name));
  const bogus = hookToolNames().filter((n) => !names.has(n));
  assert.deepEqual(bogus, [], `hook recommends non-existent tools: ${bogus.join(", ")}`);
});

test("the hook recommends a non-empty set of tools", () => {
  // Guards the parser above as much as the hook: a regex that stopped matching
  // would make the previous test pass vacuously.
  assert.ok(hookToolNames().length >= 3, "expected the hook to name several tools");
});

test("the hook's tools are the search and graph ones, not writes", () => {
  // It fires in place of a grep, so what it offers has to be read-only. Pointing
  // an agent at index_project or remember mid-grep would be a side effect.
  const WRITES = new Set(["index_project", "remember"]);
  const offending = hookToolNames().filter((n) => WRITES.has(n));
  assert.deepEqual(offending, []);
});

test("the hook uses the mcp_name variable rather than a hardcoded prefix", () => {
  // The prefix depends on the name the server was registered under, which the
  // cache carries. A literal `mcp__waycontext__` would break every user who
  // registered it as something else.
  const source = fs.readFileSync(HOOK, "utf8");
  const line = source.match(/^tools=.*$/m)[0];
  assert.doesNotMatch(line, /mcp__waycontext__/, "prefix should be interpolated, not literal");
  assert.match(line, /\$\{mcp_name\}/);
});
