import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { MANUAL_COMMANDS, helpLines } from "../src/completion.js";
import { operations } from "../src/operations.js";

test("help output is byte-identical after moving manual commands into a table", () => {
  const expected = fs.readFileSync(new URL("./fixtures/help.txt", import.meta.url), "utf8");
  const actual = execFileSync("node", ["src/cli.js", "help"], { encoding: "utf8" });
  assert.equal(actual, expected);
});

test("every hand-written switch case appears in MANUAL_COMMANDS or the registry", () => {
  // cli.js's switch and the completion word list are edited separately and
  // drift silently -- a subcommand that exists but never completes.
  const source = fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const cases = [...source.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]);

  // --version and -v are flag spellings of `version`, never typed as a subcommand.
  const typed = cases.filter((c) => c !== "--version" && c !== "-v");

  const known = new Set([
    ...MANUAL_COMMANDS.map((c) => c.name),
    ...operations.map((op) => op.name),
    ...operations.flatMap((op) => op.cli?.aliases ?? []),
  ]);

  const missing = typed.filter((c) => !known.has(c));
  assert.deepEqual(missing, [], `switch cases with no completion entry: ${missing.join(", ")}`);
});

test("every MANUAL_COMMANDS entry has a switch case implementing it", () => {
  // The other direction: a stale table entry would offer a command that errors.
  // Registry operations are excluded -- they dispatch through findOperation(),
  // not through the switch, so they legitimately have no case label.
  const source = fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const cases = new Set([...source.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]));

  const orphaned = MANUAL_COMMANDS.map((c) => c.name).filter((n) => !cases.has(n));
  assert.deepEqual(orphaned, [], `table entries with no switch case: ${orphaned.join(", ")}`);
});
