import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  operations, findOperation, parseCliArgs, usageLine, requiredArgs,
} from "../src/operations.js";

// These guard the property that motivated the registry: the MCP surface and
// the CLI must not be able to disagree about names, defaults or valid ranges.

test("every operation is fully declared", () => {
  for (const op of operations) {
    assert.ok(op.name, "missing name");
    assert.ok(op.description?.length > 20, `${op.name}: description too thin for an LLM to route on`);
    assert.equal(typeof op.handler, "function", `${op.name}: missing handler`);
    assert.ok(op.input && typeof op.input === "object", `${op.name}: missing input shape`);
    assert.ok(op.cli, `${op.name}: missing cli spec`);
    assert.equal(typeof op.cli.label, "function", `${op.name}: missing spinner label`);
    assert.equal(typeof op.readOnly, "boolean", `${op.name}: must declare readOnly`);
  }
});

// readOnlyHint is not decoration: clients auto-approve read-only tools, so a
// search tool left unannotated can raise a permission prompt while the agent's
// built-in Grep is pre-approved -- a mechanical reason to route around us.
// Getting this backwards on a writer is the worse failure, so pin the set.
test("only the operations that write are marked non-read-only", () => {
  const writers = operations.filter((op) => !op.readOnly).map((op) => op.name).sort();
  assert.deepEqual(writers, [
    "browser_capture_screenshot", "browser_navigate", "browser_session_close", "browser_session_start",
    "create_reasoning_graph", "index_project", "remember", "update_reasoning_graph",
  ]);
});

test("operation names are unique and do not collide with aliases", () => {
  const seen = new Set();
  for (const op of operations) {
    for (const token of [op.name, ...(op.cli.aliases ?? [])]) {
      assert.ok(!seen.has(token), `duplicate command token: ${token}`);
      seen.add(token);
    }
  }
});

test("every declared CLI positional maps to a real input field", () => {
  for (const op of operations) {
    for (const key of op.cli.args) {
      assert.ok(op.input[key], `${op.name}: cli arg "${key}" has no matching input field`);
    }
  }
});

test("every input field is reachable from the CLI, or explicitly declared hidden", () => {
  for (const op of operations) {
    for (const key of Object.keys(op.input)) {
      const reachable = op.cli.args.includes(key) || op.cli.hidden?.includes(key);
      assert.ok(reachable, `${op.name}: input "${key}" is unreachable from the CLI and not declared hidden`);
    }
  }
});

test("required positionals precede optional ones, so positional order is unambiguous", () => {
  for (const op of operations) {
    const required = new Set(requiredArgs(op));
    let seenOptional = false;
    for (const key of op.cli.args) {
      if (!required.has(key)) seenOptional = true;
      else assert.ok(!seenOptional, `${op.name}: required "${key}" follows an optional argument`);
    }
  }
});

// Confirming a rule is a human act, so these commands live in cli.js's switch
// rather than the registry -- which also means an operation alias must never
// shadow them, because operations are dispatched first. `knowledge export` was
// briefly exactly that bug: `knowledge` is search_knowledge's alias, so it ran
// a search for the word "export".
test("human-only admin commands are not reachable as operations", () => {
  // `serve` joins the list in Phase 5: starting a server is not something an
  // agent should be able to ask for through a tool call, and /v1/ops/:name uses
  // this same registry as its allow-list, so anything absent here is absent
  // there too.
  for (const name of ["rule", "knowledge-export", "knowledge-import", "serve", "service"]) {
    assert.equal(findOperation(name), null, `"${name}" must stay off the MCP surface`);
  }
});

test("no operation writes rules", () => {
  const writers = operations.filter((op) => /^(confirm|reject|set_rule|activate)/.test(op.name));
  assert.deepEqual(writers, [], "rule promotion must never be an operation");
});

test("findOperation resolves both canonical names and aliases", () => {
  assert.equal(findOperation("search_code").name, "search_code");
  assert.equal(findOperation("search").name, "search_code");
  assert.equal(findOperation("index").name, "index_project");
  assert.equal(findOperation("reindex").name, "index_project");
  assert.equal(findOperation("nope"), null);
});

test("reasoning graph operations are reachable by name and alias, unlike knowledge-export", () => {
  assert.equal(findOperation("create_reasoning_graph").name, "create_reasoning_graph");
  assert.equal(findOperation("reasoning-init").name, "create_reasoning_graph");
  assert.equal(findOperation("update_reasoning_graph").name, "update_reasoning_graph");
  assert.equal(findOperation("reasoning-update").name, "update_reasoning_graph");
});

test("usage lines are generated from the schema, marking optionals with brackets", () => {
  assert.equal(usageLine(findOperation("search_code")), "search_code <project> <query> [limit]");
  // `name` reads as optional on every one of these because it has a `symbol`
  // alias that also satisfies the lookup -- the handler, not the schema,
  // enforces that one of the two is present.
  assert.equal(usageLine(findOperation("get_graph")), "get_graph <project> [name] [depth]");
  assert.equal(usageLine(findOperation("get_symbol")), "get_symbol <project> [name] [limit]");
  assert.equal(usageLine(findOperation("get_callers")), "get_callers <project> [name] [limit]");
  assert.equal(usageLine(findOperation("get_callees")), "get_callees <project> [name] [limit]");
  assert.equal(usageLine(findOperation("find_related")), "find_related <project> [name] [limit]");
  assert.equal(usageLine(findOperation("list_projects")), "list_projects");
});

test("CLI string argv is coerced to the types the handler expects", () => {
  const parsed = parseCliArgs(findOperation("search_code"), ["proj", "some query", "5"]);
  assert.deepEqual(parsed, { project: "proj", query: "some query", limit: 5 });
  assert.equal(typeof parsed.limit, "number");
});

test("CLI and MCP agree on defaults", () => {
  // The defaults live in one schema, so this compares CLI parsing against
  // that same schema parsed as MCP would -- they cannot drift apart.
  for (const op of operations) {
    const required = requiredArgs(op);
    const argv = required.map(() => "x");
    const viaCli = parseCliArgs(op, argv);
    const viaMcp = z.object(op.input).parse(Object.fromEntries(required.map((k) => [k, "x"])));
    assert.deepEqual(viaCli, viaMcp, `${op.name}: CLI and MCP defaults differ`);
  }
  assert.equal(parseCliArgs(findOperation("search_code"), ["p", "q"]).limit, 10);
  assert.equal(parseCliArgs(findOperation("get_graph"), ["p", "n"]).depth, 2);
  assert.equal(parseCliArgs(findOperation("find_related"), ["p", "n"]).limit, 10);
});

// Match on the structured issue, not zod's message text: the wording changed
// wholesale between zod 3 and 4 while the codes, paths and bounds did not.
function assertRejects(opName, argv, expected) {
  assert.throws(
    () => parseCliArgs(findOperation(opName), argv),
    (e) => {
      assert.equal(e.issues?.length, 1, `${opName} ${argv.join(" ")}: expected exactly one issue`);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(e.issues[0][key], value, `${opName} ${argv.join(" ")}: issue.${key}`);
      }
      return true;
    }
  );
}

test("out-of-range numeric arguments are rejected on the CLI, not silently accepted", () => {
  assertRejects("search_code", ["p", "q", "9999"], { code: "too_big", path: ["limit"], maximum: 30 });
  assertRejects("search_code", ["p", "q", "0"], { code: "too_small", path: ["limit"], minimum: 1 });
  assertRejects("get_graph", ["p", "n", "99"], { code: "too_big", path: ["depth"], maximum: 4 });
  assertRejects("search_code", ["p", "q", "abc"], { code: "invalid_type", path: ["limit"], expected: "number" });
  assertRejects("search_code", ["p", "q", "2.5"], { code: "invalid_type", path: ["limit"], expected: "int" });
});

test("missing required arguments are rejected", () => {
  assertRejects("search_code", ["proj"], { code: "invalid_type", path: ["query"] });
  assertRejects("index_project", [], { code: "invalid_type", path: ["project"] });
});

// get_symbol's `name` is schema-optional because `symbol` is an accepted
// alias (see the MCP alias test below) -- so the "you gave me nothing to
// look up" case is enforced by the handler, with a clearer message than
// zod's "Required", not by parseCliArgs.
// Every "by symbol name" tool shares this trap: it's named after the concept
// it operates on (get_symbol, get_callers, ...), which invites a model to
// guess the parameter is called "symbol" rather than the documented `name`.
// That used to be a hard schema validation error before the handler ever
// ran (the bug get_symbol's alias was originally added for) -- confirm the
// fix, and the friendly fallback error, are wired identically on every
// sibling that takes a bare symbol name.
const SYMBOL_NAME_OPS = ["get_symbol", "get_callers", "get_callees", "get_graph", "find_related"];

test("every symbol-name tool's handler rejects a call with neither name nor symbol", () => {
  for (const opName of SYMBOL_NAME_OPS) {
    const op = findOperation(opName);
    assert.throws(
      () => op.handler({ project: "proj" }),
      /requires a `name` argument/,
      `${opName}: did not reject a call missing both name and symbol`
    );
  }
});

test("every symbol-name tool accepts `symbol` as an alias for `name`", () => {
  for (const opName of SYMBOL_NAME_OPS) {
    const op = findOperation(opName);
    const parsed = z.object(op.input).parse({ project: "proj", symbol: "Foo::bar" });
    assert.equal(parsed.symbol, "Foo::bar", `${opName}: symbol not accepted`);
    assert.equal(parsed.name, undefined, `${opName}: name should stay unset`);
  }
});

test("extra positional arguments are ignored rather than misassigned", () => {
  const parsed = parseCliArgs(findOperation("get_module"), ["proj", "src/thing", "junk"]);
  assert.deepEqual(parsed, { project: "proj", module: "src/thing" });
});

test("only index_project streams progress and needs the schema ensured", () => {
  for (const op of operations) {
    const expected = op.name === "index_project";
    assert.equal(!!op.cli.streams, expected, `${op.name}: unexpected streams flag`);
    assert.equal(!!op.cli.ensureSchema, expected, `${op.name}: unexpected ensureSchema flag`);
  }
});

test("labels render without throwing for every operation", () => {
  for (const op of operations) {
    const args = Object.fromEntries(op.cli.args.map((k) => [k, "sample"]));
    assert.equal(typeof op.cli.label(args), "string", `${op.name}: label did not return a string`);
  }
});

// index_project used to require `path` over MCP, so a model re-indexing an
// already-indexed project by name alone (as the after-commit rule reads) got
// a bare "Required at path" validation error. The CLI still fills `path`
// from the working tree, so it keeps counting it as a required positional.
test("index_project accepts a call without path over MCP, but the CLI still fills it", () => {
  const op = findOperation("index_project");
  assert.deepEqual(z.object(op.input).parse({ project: "p" }), { project: "p" });
  assert.deepEqual(requiredArgs(op), ["project", "path"]);
  assert.equal(usageLine(op), "index_project <project> <path>");
});
