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
  }
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

test("every input field is reachable from the CLI", () => {
  for (const op of operations) {
    for (const key of Object.keys(op.input)) {
      assert.ok(op.cli.args.includes(key), `${op.name}: input "${key}" is unreachable from the CLI`);
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
  for (const name of ["rule", "knowledge-export", "knowledge-import"]) {
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

test("usage lines are generated from the schema, marking optionals with brackets", () => {
  assert.equal(usageLine(findOperation("search_code")), "search_code <project> <query> [limit]");
  assert.equal(usageLine(findOperation("get_graph")), "get_graph <project> <name> [depth]");
  assert.equal(usageLine(findOperation("get_symbol")), "get_symbol <project> <name>");
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

test("out-of-range numeric arguments are rejected on the CLI, not silently accepted", () => {
  assert.throws(() => parseCliArgs(findOperation("search_code"), ["p", "q", "9999"]), /less than or equal to 30/);
  assert.throws(() => parseCliArgs(findOperation("search_code"), ["p", "q", "0"]), /greater than or equal to 1/);
  assert.throws(() => parseCliArgs(findOperation("get_graph"), ["p", "n", "99"]), /less than or equal to 4/);
  assert.throws(() => parseCliArgs(findOperation("search_code"), ["p", "q", "abc"]), /Expected number/);
  assert.throws(() => parseCliArgs(findOperation("search_code"), ["p", "q", "2.5"]), /integer/);
});

test("missing required arguments are rejected", () => {
  assert.throws(() => parseCliArgs(findOperation("get_symbol"), ["proj"]), /Required/);
  assert.throws(() => parseCliArgs(findOperation("index_project"), []), /Required/);
});

test("extra positional arguments are ignored rather than misassigned", () => {
  const parsed = parseCliArgs(findOperation("get_symbol"), ["proj", "Thing", "junk"]);
  assert.deepEqual(parsed, { project: "proj", name: "Thing" });
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
