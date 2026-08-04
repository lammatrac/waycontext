import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  MANUAL_COMMANDS, helpLines, generateBash, completeWords, assertSafeForBash,
} from "../src/completion.js";
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

/** Source the generated script in a clean bash and return what Tab would offer. */
function complete(words, cword, env = {}) {
  const script = generateBash();
  const driver = [
    script,
    `COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")})`,
    `COMP_CWORD=${cword}`,
    "_waycontext",
    'printf "%s\\n" "${COMPREPLY[@]:-}"',
  ].join("\n");
  const r = spawnSync("bash", ["--norc", "--noprofile", "-c", driver], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    words: r.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    stderr: r.stderr,
    status: r.status,
  };
}

test("the generated script is valid bash", () => {
  const r = spawnSync("bash", ["-n"], { input: generateBash(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the generated script names every command, alias and manual entry", () => {
  // A substring match against completeWords() would pass even if a word went
  // missing entirely, as long as it happens to be a substring of a word that
  // is still present (e.g. dropping the alias "search" would go unnoticed
  // since "search_code" still contains it). Parse out exactly what
  // _WC_COMMANDS holds and compare the two sets directly instead.
  const script = generateBash();
  const listed = script.match(/_WC_COMMANDS='([^']*)'/)[1].split(" ");
  assert.deepEqual(listed.sort(), completeWords().sort());
});

test("assertSafeForBash passes conservative names through unchanged", () => {
  const words = ["search_code", "knowledge-export", "init-db"];
  assert.deepEqual(assertSafeForBash(words), words);
});

test("assertSafeForBash throws, naming the offending word, on anything else", () => {
  assert.throws(
    () => assertSafeForBash(["fine", "it's a trap"]),
    /it's a trap/,
  );
  assert.throws(() => assertSafeForBash(["*"]), /\*/);
  assert.throws(() => assertSafeForBash(["has space"]), /has space/);
});

test("generateBash never emits a word that fails the bash-safety guard", () => {
  // Documents *why* generateBash() is safe today rather than just asserting
  // it once: every word completeWords() can currently produce satisfies the
  // same guard Task 3's flags and sub-verbs must also flow through.
  assert.doesNotThrow(() => assertSafeForBash(completeWords()));
});

test("a bare prefix completes to the matching subcommand", () => {
  const { words, stderr, status } = complete(["waycontext", "us"], 1);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(words, ["usage"]);
});

test("an ambiguous prefix offers every match", () => {
  const { words } = complete(["waycontext", "search"], 1);
  assert.deepEqual(words.sort(), ["search", "search_code", "search_knowledge"]);
});

test("both installed bin names are registered", () => {
  assert.match(generateBash(), /complete -F _waycontext waycontext codecontext/);
});
